import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';

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
 */
export function launchChat({ prompt, url, repo, number, title, isIssue }) {
  const itemType = isIssue ? 'issue' : 'PR';
  const repoShort = repo.split('/').pop();
  const tmpBase = platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp';
  const sessionDir = join(tmpBase, `github-status-chat-${repoShort}-${number}-${Date.now()}`);

  mkdirSync(sessionDir, { recursive: true });

  const claudeMd = `# Context: ${itemType} #${number} — ${title}

- Repo: ${repo}
- URL: ${url}
- Type: ${itemType}

## Instructions

You are helping me discuss ${itemType} #${number} in ${repo}.
The full context (diff, comments, timeline, CI status) is below.
Start by giving a brief summary of the current state, then ask what I'd like to discuss.

## Full Context

${prompt}
`;

  writeFileSync(join(sessionDir, 'CLAUDE.md'), claudeMd);

  if (platform === 'win32') {
    const launchScript = join(sessionDir, 'launch.cmd');
    writeFileSync(launchScript, `@echo off\r\ncd /d ${JSON.stringify(sessionDir)}\r\nclaude\r\n`);
    spawn('cmd', ['/c', 'start', 'cmd', '/k', launchScript], { stdio: 'ignore', detached: true }).unref();
  } else {
    const launchScript = join(sessionDir, 'launch.sh');
    writeFileSync(launchScript, `#!/bin/bash\ncd ${JSON.stringify(sessionDir)}\nclaude\n`, { mode: 0o755 });

    if (platform === 'darwin') {
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
