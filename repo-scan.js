import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runCmd } from './helpers.js';

/**
 * Extract "org/repo" from a git remote URL.
 * Handles https://github.com/org/repo.git, git@github.com:org/repo.git, etc.
 */
function extractRepoFromRemote(remote) {
  const m = remote.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/**
 * Read origin URL from .git/config without spawning a process.
 */
function readOriginUrl(gitDir) {
  const configPath = join(gitDir, 'config');
  if (!existsSync(configPath)) return null;
  const config = readFileSync(configPath, 'utf8');
  const m = config.match(/\[remote "origin"\][^\[]*?url\s*=\s*(.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Read current branch from .git/HEAD without spawning a process.
 * Returns branch name or null (detached HEAD).
 */
function readCurrentBranch(gitDir) {
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;
  const head = readFileSync(headPath, 'utf8').trim();
  const m = head.match(/^ref: refs\/heads\/(.+)$/);
  return m ? m[1] : null;
}

/**
 * Read a ref's commit hash. Checks loose refs first, then packed-refs.
 */
function readRef(gitDir, ref) {
  const loosePath = join(gitDir, ref);
  if (existsSync(loosePath)) {
    return readFileSync(loosePath, 'utf8').trim();
  }

  const packedPath = join(gitDir, 'packed-refs');
  if (existsSync(packedPath)) {
    const packed = readFileSync(packedPath, 'utf8');
    const m = packed.match(new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    return m ? m[1] : null;
  }

  return null;
}

/**
 * Probe a single clone directory for branch, dirty, and behind-origin state.
 * Reads git internals directly where possible; only spawns git for dirty check.
 */
async function probeClone(dir, branch, headSha) {
  const gitDir = join(dir, '.git');
  const result = {
    path: dir,
    currentBranch: null,
    onPRBranch: false,
    dirty: false,
    changedFiles: [],
    hasBranchLocally: false,
    behindOrigin: false,
    localHead: null,
    remoteHead: null,
  };

  result.currentBranch = readCurrentBranch(gitDir);
  if (!result.currentBranch) return result;

  if (branch) {
    result.onPRBranch = result.currentBranch === branch;
    result.localHead = readRef(gitDir, `refs/heads/${branch}`);
    result.remoteHead = headSha || readRef(gitDir, `refs/remotes/origin/${branch}`);
    result.hasBranchLocally = !!result.localHead;
    result.behindOrigin = !!(result.localHead && result.remoteHead && result.localHead !== result.remoteHead);
  }

  // Dirty check — needs git process (index comparison)
  const status = await runCmd('git', ['status', '--porcelain'], { cwd: dir });
  if (status) {
    result.dirty = true;
    result.changedFiles = status.split('\n');
  }

  return result;
}

/**
 * Scan all git repos in ~ (depth 2) and find clones whose origin matches the given repo.
 * Returns sorted results: on PR branch first, then clean, then dirty.
 *
 * @param {string} repo - Full repo name (e.g. "org/repo")
 * @param {string|null} branch - PR branch name (null for issues)
 * @returns {Promise<{clones: object[], repo: string, branch: string|null, suggestedClonePath: string}>}
 */
export async function scanForClones(repo, branch, headSha) {
  const home = homedir();
  if (!existsSync(home)) return { clones: [], repo, branch, suggestedClonePath: '' };
  const entries = readdirSync(home, { withFileTypes: true });

  const skipDirs = new Set(['Downloads', 'Documents', 'Desktop', 'Library', 'Music', 'Movies', 'Pictures', 'Public', 'Applications']);
  const depth1 = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !skipDirs.has(e.name))
    .map(e => join(home, e.name));

  const gitDirs = [];
  for (const dir of depth1) {
    if (existsSync(join(dir, '.git'))) {
      gitDirs.push(dir);
    } else {
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.startsWith('.') && existsSync(join(dir, sub.name, '.git'))) {
          gitDirs.push(join(dir, sub.name));
        }
      }
    }
  }

  // Match by reading .git/config directly (no process spawn)
  const repoLower = repo.toLowerCase();
  const clones = [];
  for (const dir of gitDirs) {
    const originUrl = readOriginUrl(join(dir, '.git'));
    if (!originUrl) continue;
    const remoteRepo = extractRepoFromRemote(originUrl);
    if (!remoteRepo || remoteRepo.toLowerCase() !== repoLower) continue;
    clones.push(await probeClone(dir, branch, headSha));
  }

  // Sort: on PR branch first, then clean, then dirty
  clones.sort((a, b) => {
    if (a.onPRBranch !== b.onPRBranch) return a.onPRBranch ? -1 : 1;
    if (a.dirty !== b.dirty) return a.dirty ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  // Compute next available clone path: ~/repo, ~/repo_2, ~/repo_3, ...
  const repoShort = repo.split('/').pop();
  let suggestedClonePath = join(home, repoShort);
  if (existsSync(suggestedClonePath)) {
    let i = 2;
    while (existsSync(join(home, `${repoShort}_${i}`))) i++;
    suggestedClonePath = join(home, `${repoShort}_${i}`);
  }

  return { clones, repo, branch, suggestedClonePath };
}
