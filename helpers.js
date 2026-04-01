import { spawn } from 'node:child_process';

// Emperor protects! :pray:
export const CHAOS = false;

export const CMD_TIMEOUT = 60000;

const commandLog = [];
export function getCommandLog() { return commandLog; }
export function resetCommandLog() { commandLog.length = 0; }
let cmdLogHook = null;
export function setCmdLogHook(fn) { cmdLogHook = fn; }

export function runCmd(bin, args, { stdin, env: cmdEnv, signal, cwd } = {}) {
  const cmd = `${bin} ${args.join(' ')}`;
  console.log(`runCmd > ${cmd}`);
  const startTime = Date.now();
  let shellBin = bin, shellArgs = args;
  if (CHAOS) {
    const escaped = args.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
    shellBin = 'sh';
    shellArgs = ['-c', `./bin/chaotic-testing && ${bin} ${escaped}`];
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`Aborted before start: ${cmd}`)); return; }
    const child = spawn(shellBin, shellArgs, { cwd, env: cmdEnv, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const kill = () => { child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); }, 2000); };
    const timer = setTimeout(kill, CMD_TIMEOUT);
    const onAbort = () => { kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const duration = Date.now() - startTime;
      const entry = { cmd, duration, startTime, ok: code === 0 };
      if (code !== 0) entry.error = stderr || `Exit code ${code}`;
      commandLog.push(entry);
      if (cmdLogHook) cmdLogHook(entry);
      if (signal?.aborted) reject(new Error(`Aborted: ${cmd}`));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(code === null ? `Command timed out after ${CMD_TIMEOUT / 1000}s: ${cmd}` : `Command failed: ${cmd}\n${stderr || `Exit code ${code}`}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      const entry = { cmd, duration: Date.now() - startTime, startTime, ok: false, error: err.message };
      commandLog.push(entry);
      if (cmdLogHook) cmdLogHook(entry);
      reject(new Error(`Command failed: ${cmd}\n${err.message}`));
    });
  });
}

export async function gh(...args) {
  const signal = args.length && args[args.length - 1] instanceof AbortSignal ? args.pop() : undefined;
  return runCmd('gh', args, { signal });
}

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function daysSince(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

export function daysClass(days) {
  if (days <= 3) return 'good';
  if (days <= 14) return 'warning';
  return 'bad';
}

export function todayStr() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  now.setMinutes(now.getMinutes() - offset);
  return now.toISOString().slice(0, 16).replace('T', ' ');
}
