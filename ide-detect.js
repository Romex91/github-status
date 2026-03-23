import { readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const IDE_CANDIDATES = [
  { id: 'cursor',   name: 'Cursor',   cmd: 'cursor',   mac: 'Cursor.app' },
  { id: 'code',     name: 'VS Code',  cmd: 'code',     mac: 'Visual Studio Code.app' },
  { id: 'windsurf', name: 'Windsurf', cmd: 'windsurf', mac: 'Windsurf.app' },
  { id: 'zed',      name: 'Zed',      cmd: 'zed',      mac: 'Zed.app' },
  { id: 'idea',     name: 'IntelliJ', cmd: 'idea',     mac: 'IntelliJ IDEA.app' },
  { id: 'webstorm', name: 'WebStorm', cmd: 'webstorm', mac: 'WebStorm.app' },
  { id: 'rubymine', name: 'RubyMine', cmd: 'rubymine', mac: 'RubyMine.app' },
  { id: 'goland',   name: 'GoLand',   cmd: 'goland',   mac: 'GoLand.app' },
  { id: 'pycharm',  name: 'PyCharm',  cmd: 'pycharm',  mac: 'PyCharm.app' },
  { id: 'subl',     name: 'Sublime',  cmd: 'subl',     mac: 'Sublime Text.app' },
  { id: 'fleet',    name: 'Fleet',    cmd: 'fleet',    mac: 'Fleet.app' },
];

/**
 * Detect installed IDEs by checking CLI tools in PATH and macOS /Applications.
 * Runs once at startup — results are cached.
 * @returns {{ id: string, name: string, cmd: string }[]}
 */
export function detectIDEs() {
  const macApps = new Set();
  if (process.platform === 'darwin') {
    try { for (const e of readdirSync('/Applications')) macApps.add(e); } catch {}
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const found = [];
  for (const ide of IDE_CANDIDATES) {
    let hasCli = false;
    try { execSync(`${whichCmd} ${ide.cmd}`, { stdio: 'ignore' }); hasCli = true; } catch {}
    const hasApp = ide.mac && macApps.has(ide.mac);
    if (hasCli || hasApp) {
      found.push({ id: ide.id, name: ide.name, cmd: ide.cmd });
    }
  }
  return found;
}
