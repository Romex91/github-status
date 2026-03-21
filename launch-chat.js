import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Launch an interactive claude session in a new terminal window
 * with PR/issue context pre-loaded via CLAUDE.md.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The full context prompt (diff, comments, timeline, etc.)
 * @param {string} opts.url - The PR/issue URL (e.g. https://github.com/org/repo/pull/123)
 * @param {string} opts.repo - Full repo name (e.g. "org/repo")
 * @param {number} opts.number - PR/issue number
 * @param {string} opts.title - PR/issue title
 * @param {boolean} [opts.isIssue] - Whether this is an issue (vs PR)
 * @param {string} [opts.branch] - PR head branch name
 */
export function launchChat({ prompt, url, repo, number, title, isIssue, branch }) {
  const itemType = isIssue ? 'issue' : 'PR';
  const repoShort = repo.split('/').pop();
  const tmpBase = platform() === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp';
  const sessionDir = join(tmpBase, `github-status-chat-${repoShort}-${number}-${Date.now()}`);

  mkdirSync(sessionDir, { recursive: true });

  // Probe local repo state
  const localRepo = probeLocalRepo(repo, branch);
  const instructions = buildInstructions({ itemType, repo, number, branch, localRepo });

  const claudeMd = `# Context: ${itemType} #${number} — ${title}

- Repo: ${repo}
- URL: ${url}
- Type: ${itemType}
${localRepo.exists ? `- Local clone: ${localRepo.path}` : ''}
${branch ? `- Branch: ${branch}` : ''}

## Instructions

${instructions}

## Full Context

${prompt}
`;

  writeFileSync(join(sessionDir, 'CLAUDE.md'), claudeMd);

  if (platform() === 'win32') {
    const launchScript = join(sessionDir, 'launch.cmd');
    writeFileSync(launchScript, `@echo off\r\ncd /d ${JSON.stringify(sessionDir)}\r\n\r\nrem Start claude with PR context from CLAUDE.md\r\nclaude\r\n`);
    spawn('cmd', ['/c', 'start', 'cmd', '/k', launchScript], { stdio: 'ignore', detached: true }).unref();
  } else {
    const launchScript = join(sessionDir, 'launch.sh');
    writeFileSync(launchScript, [
      '#!/bin/bash',
      `# Chat about ${itemType} #${number} in ${repo}`,
      `# Context is in CLAUDE.md next to this script`,
      '',
      `cd ${JSON.stringify(sessionDir)}`,
      'claude "print pwd and prompt the user"',
      '',
    ].join('\n'), { mode: 0o755 });

    if (platform() === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "bash ${launchScript}"`], { stdio: 'ignore', detached: true }).unref();
    } else {
      // Linux — try common terminal emulators in order of popularity
      const terminals = [
        ['gnome-terminal', ['--', 'bash', launchScript]],
        ['konsole', ['-e', 'bash', launchScript]],
        ['xfce4-terminal', ['-e', `bash ${launchScript}`]],
        ['xterm', ['-e', 'bash', launchScript]],
      ];
      let launched = false;
      for (const [bin, args] of terminals) {
        try {
          spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
          launched = true;
          break;
        } catch {}
      }
      if (!launched) {
        console.error('No supported terminal emulator found. Tried: ' + terminals.map(t => t[0]).join(', '));
      }
    }
  }

  return sessionDir;
}

/**
 * Check if ~/repo exists, what branch it's on, and if it has uncommitted changes.
 * Returns { path, exists, currentBranch, onBranch, dirty, changedFiles }
 */
function probeLocalRepo(repo, branch) {
  const repoShort = repo.split('/').pop();
  const repoPath = join(homedir(), repoShort);
  const result = { path: repoPath, exists: false, currentBranch: null, onBranch: false, dirty: false, changedFiles: [], upToDate: false, localHead: null, remoteHead: null };

  if (!existsSync(join(repoPath, '.git'))) return result;
  result.exists = true;

  try {
    result.currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
    result.onBranch = branch && result.currentBranch === branch;

    if (branch) {
      try {
        execSync('git fetch origin ' + branch, { cwd: repoPath, encoding: 'utf8', timeout: 10000 });
      } catch {}
      // Resolve the local ref for the branch (works even when not checked out)
      try {
        result.localHead = execSync(`git rev-parse refs/heads/${branch}`, { cwd: repoPath, encoding: 'utf8' }).trim();
      } catch {}
      try {
        result.remoteHead = execSync(`git rev-parse origin/${branch}`, { cwd: repoPath, encoding: 'utf8' }).trim();
      } catch {}
      result.upToDate = !!(result.localHead && result.remoteHead && result.localHead === result.remoteHead);
    }
  } catch {}

  try {
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' }).trim();
    if (status) {
      result.dirty = true;
      result.changedFiles = status.split('\n');
    }
  } catch {}

  return result;
}

/**
 * Build CLAUDE.md instructions tailored to the local repo state.
 */
function buildInstructions({ itemType, repo, number, branch, localRepo }) {
  const preamble = `You are helping me discuss ${itemType} #${number} in ${repo}.
The full context (diff, comments, timeline, CI status) is below.
Start by giving a brief summary of the current state.`;

  const repoShort = repo.split('/').pop();

  const dirtyFiles = localRepo.dirty ? `
There are uncommitted changes:
\`\`\`
${localRepo.changedFiles.join('\n')}
\`\`\`` : '';

  const behindOrigin = (!localRepo.upToDate && localRepo.localHead && localRepo.remoteHead) ? `
The local branch \`${branch}\` is behind origin.
Local HEAD:  ${localRepo.localHead}
Remote HEAD: ${localRepo.remoteHead}` : '';

  const staleWarning = `

IMPORTANT: If the user declines to update, clone, or checkout the local repo, do NOT read or reference files from ~/${repoShort}. The local code may be outdated or irrelevant — rely only on the PR context above.`;

  const closing = `${staleWarning}
Then proceed to help with the code.`;

  // Issues don't have branches
  if (!branch) {
    const ctx = localRepo.exists ? `\nThe local clone is at ${localRepo.path} (on branch \`${localRepo.currentBranch}\`).` : '';
    return `${preamble}${ctx}${closing}`;
  }

  // No local clone found
  if (!localRepo.exists) {
    return `${preamble}

No local clone of ${repo} was found at ~/${repoShort}.

Ask me:
1. Do you want me to clone it? (\`gh repo clone ${repo} ~/${repoShort}\` and checkout \`${branch}\`)
2. Or we can just chat about the PR without a local copy.${closing}`;
  }

  // Already on the right branch
  if (localRepo.onBranch) {
    if (!localRepo.dirty && !behindOrigin) {
      return `${preamble}

The local clone at ${localRepo.path} is on branch \`${branch}\` and up to date with origin.${closing}`;
    }
    // Dirty + behind origin — conflicting state, bail out
    if (localRepo.dirty && behindOrigin) {
      return `${preamble}

The local clone at ${localRepo.path} is on branch \`${branch}\`, but it has uncommitted changes AND is behind origin. This is a conflict — we can't safely pull or use the local code.
${dirtyFiles}
${behindOrigin}

Tell me:
Hey, your local \`${branch}\` has uncommitted changes and is also behind origin — I'll work from the PR context only so we don't mix things up.

Do NOT read or reference files from ~/${repoShort}.
Then proceed to help with the code.`;
    }

    // Dirty only (up to date with origin)
    if (localRepo.dirty) {
      return `${preamble}

The local clone at ${localRepo.path} is on branch \`${branch}\`.
${dirtyFiles}

Ask me:
1. Do you want me to commit the uncommitted changes? — suggest a commit message.
2. Or we can just chat about the PR, without referring to ~/${repoShort}.${closing}`;
    }

    // Behind origin only (clean)
    return `${preamble}

The local clone at ${localRepo.path} is on branch \`${branch}\`.
${behindOrigin}

Ask me:
1. Do you want me to \`git pull\` to get the latest?
2. Or we can just chat about the PR, without referring to ~/${repoShort}.${closing}`;
  }

  // On a different branch — dirty means we can't checkout
  if (localRepo.dirty) {
    return `${preamble}

The local clone is at ${localRepo.path}, currently on branch \`${localRepo.currentBranch}\`.
${dirtyFiles}

Tell me:
Hey, I noticed you have uncommitted changes in ~/${repoShort}, so I can't just checkout \`${branch}\`.
1. We could commit those first — suggest a commit message — then checkout \`${branch}\`.
2. Or we can just chat about the PR without checking out the branch.${closing}`;
  }

  // Clean, on a different branch
  return `${preamble}

The local clone is at ${localRepo.path}, currently on branch \`${localRepo.currentBranch}\`.

Ask me:
1. Do you want me to checkout \`${branch}\` in ${localRepo.path}?
2. Or we can just chat about the PR without checking out the branch.
${behindOrigin}${closing}`;
}
