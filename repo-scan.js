import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runCmd } from './helpers.js';

/**
 * Extract "org/repo" from a git remote URL.
 * Handles https://github.com/org/repo.git, git@github.com:org/repo.git, etc.
 */
function extractRepoFromRemote(remote) {
  const match = remote.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

/**
 * Read origin URL from .git/config without spawning a process.
 */
function readOriginUrl(gitDir) {
  const configPath = join(gitDir, 'config');
  if (!existsSync(configPath)) return null;
  const config = readFileSync(configPath, 'utf8');
  const match = config.match(/\[remote "origin"\][^\[]*?url\s*=\s*(.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Read current branch from .git/HEAD without spawning a process.
 * Returns branch name or null (detached HEAD).
 */
function readCurrentBranch(gitDir) {
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;
  const head = readFileSync(headPath, 'utf8').trim();
  const match = head.match(/^ref: refs\/heads\/(.+)$/);
  return match ? match[1] : null;
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
    const match = packed.match(new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    return match ? match[1] : null;
  }

  return null;
}

/**
 * Check if local and remote refs have diverged.
 * Returns 'ahead' | 'behind' | 'diverged' | null (same or missing refs).
 */
export async function checkDivergence(cwd, localHead, remoteHead) {
  if (!localHead || !remoteHead || localHead === remoteHead) return null;
  // If the remote commit doesn't exist locally, we can't determine the relationship
  const remoteExists = await runCmd('git', ['cat-file', '-t', remoteHead], { cwd }).then(() => true, () => false);
  if (!remoteExists) return null;
  const remoteIsAncestor = await runCmd('git', ['merge-base', '--is-ancestor', remoteHead, localHead], { cwd }).then(() => true, () => false);
  if (remoteIsAncestor) return 'ahead';
  const localIsAncestor = await runCmd('git', ['merge-base', '--is-ancestor', localHead, remoteHead], { cwd }).then(() => true, () => false);
  return localIsAncestor ? 'behind' : 'diverged';
}

/**
 * Recursively find all git repos under a directory (no depth limit).
 * Stops descending into a directory once a .git folder is found there.
 */
function findGitRepos(dir, skipDirs, gitDirs) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || skipDirs.has(e.name)) continue;
    const full = join(dir, e.name);
    if (existsSync(join(full, '.git'))) {
      gitDirs.push(full);
    } else {
      findGitRepos(full, skipDirs, gitDirs);
    }
  }
}

/**
 * Scan all git repos in ~ (unlimited depth) once. For each clone, read origin repo,
 * current branch, local/remote refs, and dirty status.
 * Returns a Map<repoNameLower, CloneInfo[]> for instant lookup.
 */
export async function buildCloneIndex(log) {
  const home = homedir();
  if (log) log('Scanning local git repos...', 'info');
  if (!existsSync(home)) return new Map();

  const skipDirs = new Set(['Downloads', 'Documents', 'Desktop', 'Library', 'Music', 'Movies', 'Pictures', 'Public', 'Applications', 'node_modules', '.Trash']);
  const gitDirs = [];
  findGitRepos(home, skipDirs, gitDirs);

  const index = new Map();

  for (const dir of gitDirs) {
    const gitDir = join(dir, '.git');
    const originUrl = readOriginUrl(gitDir);
    if (!originUrl) continue;
    const remoteRepo = extractRepoFromRemote(originUrl);
    if (!remoteRepo) continue;

    if (log) log(`  scanning ${dir.replace(home, '~')} → ${remoteRepo}`, 'info');

    const currentBranch = readCurrentBranch(gitDir);
    const status = await runCmd('git', ['status', '--porcelain'], { cwd: dir });
    const dirty = !!status;
    const changedFiles = status ? status.split('\n') : [];

    const key = remoteRepo.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ path: dir, currentBranch, dirty, changedFiles });
  }

  const summary = `Clone index: ${gitDirs.length} repos scanned, ${index.size} unique remotes`;
  console.log(summary);
  if (log) log(summary, 'info');
  return index;
}

/**
 * Look up clones for a repo from the pre-built index.
 * Derives branch-specific fields (onPRBranch, behindOrigin, etc.) from stored refs.
 */
export async function scanForClones(repo, branch, headSha, index) {
  const home = homedir();
  const matches = index.get(repo.toLowerCase()) || [];

  const clones = await Promise.all(matches.map(async clone => {
    const gitDir = join(clone.path, '.git');
    const onPRBranch = branch ? clone.currentBranch === branch : false;
    const localHead = branch ? readRef(gitDir, `refs/heads/${branch}`) : null;
    const trackingHead = branch ? readRef(gitDir, `refs/remotes/origin/${branch}`) : null;
    const remoteHead = branch ? (headSha || trackingHead) : null;
    const hasBranchLocally = !!localHead;

    // Use headSha for divergence check, fall back to tracking ref if it doesn't exist locally.
    // If neither works but API says remote differs, assume behind (pull will do the real check).
    const divergeStatus = await checkDivergence(clone.path, localHead, remoteHead)
      ?? await checkDivergence(clone.path, localHead, trackingHead);
    const behindOrigin = divergeStatus === 'behind' || (divergeStatus === null && localHead && remoteHead && localHead !== remoteHead);
    const diverged = divergeStatus === 'diverged';

    return {
      path: clone.path,
      currentBranch: clone.currentBranch,
      onPRBranch,
      dirty: clone.dirty,
      changedFiles: clone.changedFiles,
      hasBranchLocally,
      behindOrigin,
      diverged,
      localHead,
      remoteHead,
    };
  }));

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
