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
 * Scan all git repos in ~ (depth 2) once. For each clone, read origin repo,
 * current branch, local/remote refs, and dirty status.
 * Returns a Map<repoNameLower, CloneInfo[]> for instant lookup.
 */
export async function buildCloneIndex(log) {
  const home = homedir();
  if (log) log('Scanning local git repos...', 'info');
  if (!existsSync(home)) return new Map();
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
    const remoteHead = branch ? (headSha || readRef(gitDir, `refs/remotes/origin/${branch}`)) : null;
    const hasBranchLocally = !!localHead;

    // Only "behind" if origin has commits local doesn't (not when local is ahead)
    let behindOrigin = false;
    if (localHead && remoteHead && localHead !== remoteHead) {
      // If remoteHead is ancestor of localHead, local is ahead — not behind
      const isAncestor = await runCmd('git', ['merge-base', '--is-ancestor', remoteHead, localHead], { cwd: clone.path }).then(() => true, () => false);
      behindOrigin = !isAncestor;
    }

    return {
      path: clone.path,
      currentBranch: clone.currentBranch,
      onPRBranch,
      dirty: clone.dirty,
      changedFiles: clone.changedFiles,
      hasBranchLocally,
      behindOrigin,
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
