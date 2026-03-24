import { spawn } from 'node:child_process';
import { runCmd } from './helpers.js';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

const PROMPTS_DIR = new URL('./data/chat-prompts/', import.meta.url).pathname;
mkdirSync(PROMPTS_DIR, { recursive: true });

/**
 * Remove chat prompt files older than maxAgeDays.
 */
export function cleanChatPrompts(maxAgeDays = 1) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of readdirSync(PROMPTS_DIR)) {
    const filePath = join(PROMPTS_DIR, file);
    if (!existsSync(filePath)) continue;
    const st = statSync(filePath);
    if (st.mtimeMs < cutoff) {
      unlinkSync(filePath);
      removed++;
    }
  }
  if (removed > 0) console.log(`Cleaned ${removed} stale chat prompt(s)`);
}

/**
 * Launch an interactive claude session in a new terminal window
 * with PR/issue context passed via --append-system-prompt flag.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The full context (diff, comments, timeline, etc.)
 * @param {string} opts.url - The PR/issue URL
 * @param {string} opts.repo - Full repo name (e.g. "org/repo")
 * @param {number} opts.number - PR/issue number
 * @param {string} opts.title - PR/issue title
 * @param {boolean} [opts.isIssue] - Whether this is an issue (vs PR)
 * @param {string} [opts.branch] - PR head branch name
 * @param {string} [opts.aiStatus] - AI-generated status summary
 * @param {string} [opts.action] - "checkout", "pull", "clone", "chat-here"
 * @param {string} [opts.clonePath] - Path to local clone (for checkout/pull/chat-here)
 */
export async function launchChat({ prompt, url, repo, number, title, isIssue, branch, aiStatus, action = 'chat-here', clonePath }) {
  const itemType = isIssue ? 'issue' : 'PR';
  const repoShort = repo.split('/').pop();

  // Execute git action if needed
  if (clonePath && action === 'checkout' && branch) {
    await runCmd('git', ['checkout', branch], { cwd: clonePath });
  } else if (clonePath && action === 'pull') {
    await runCmd('git', ['pull'], { cwd: clonePath });
  } else if (action === 'clone' && clonePath && branch) {
    await runCmd('gh', ['repo', 'clone', repo, clonePath]);
    await runCmd('git', ['checkout', branch], { cwd: clonePath });
  }

  // Write prompt to data/chat-prompts/
  const promptFile = join(PROMPTS_DIR, `${repoShort}-${number}-${Date.now()}.md`);
  const promptContent = `# Context: ${itemType} #${number} — ${title}

- Repo: ${repo}
- URL: ${url}
- Type: ${itemType}
${branch ? `- Branch: ${branch}` : ''}
${aiStatus ? `- AI Status: ${aiStatus}` : ''}

## Instructions

You are helping me with ${itemType} #${number} in ${repo}.
The full context (diff, comments, timeline, CI status) is below.
Start by giving a brief summary of the current state, then help with the code.

## Full Context

${prompt}
`;
  writeFileSync(promptFile, promptContent);

  if (!clonePath) {
    throw new Error('No local clone path provided — cannot launch chat without a repo checkout.');
  }
  const workDir = clonePath;

  // Launch terminal with claude reading the prompt file
  const claudeCmd = `claude --append-system-prompt-file ${JSON.stringify(promptFile)} "In short sentence, summarize the context"`;

  if (platform() === 'win32') {
    const script = `@echo off\r\ncd /d ${JSON.stringify(workDir)}\r\n${claudeCmd}\r\n`;
    const scriptPath = join(PROMPTS_DIR, `launch-${Date.now()}.cmd`);
    writeFileSync(scriptPath, script);
    spawn('cmd', ['/c', 'start', 'cmd', '/k', scriptPath], { stdio: 'ignore', detached: true }).unref();
  } else {
    if (platform() === 'darwin') {
      const cmd = `cd ${JSON.stringify(workDir)} && ${claudeCmd}`;
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], { stdio: 'ignore', detached: true }).unref();
    } else {
      const scriptPath = join(PROMPTS_DIR, `launch-${Date.now()}.sh`);
      writeFileSync(scriptPath, `#!/bin/bash\ncd ${JSON.stringify(workDir)}\n${claudeCmd}\n`, { mode: 0o755 });
      const terminals = [
        ['gnome-terminal', ['--', 'bash', scriptPath]],
        ['konsole', ['-e', 'bash', scriptPath]],
        ['xfce4-terminal', ['-e', `bash ${scriptPath}`]],
        ['xterm', ['-e', 'bash', scriptPath]],
      ];
      let launched = false;
      for (const [bin, args] of terminals) {
        const found = await runCmd('which', [bin]).then(() => true, () => false);
        if (found) {
          spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
          launched = true;
          break;
        }
      }
      if (!launched) {
        throw new Error('No supported terminal emulator found. Tried: ' + terminals.map(t => t[0]).join(', '));
      }
    }
  }
}
