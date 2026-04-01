import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCmd, gh, daysSince, todayStr, resetCommandLog, getCommandLog, setCmdLogHook } from './helpers.js';
import { loadRepoColors, updateRepoColors } from './repo-colors.js';
import { fetchMyPRs, fetchReviewPRs, fetchMentionedPRs, fetchAssignedIssues, fetchMentionedIssues, fetchCreatedIssues, fetchCommentedPRs, fetchCommentedIssues } from './github-api.js';
import { handleAIStream } from './ai-status.js';
import { INDEX_HTML, buildDashboardHtml } from './dashboard-html.js';
import { launchChat } from './launch-chat.js';
import { buildCloneIndex, scanForClones, checkDivergence } from './repo-scan.js';
import { detectIDEs } from './ide-detect.js';

const PROJECT_DIR = new URL('.', import.meta.url).pathname;
const PORT = process.env.PORT || 7777;
const DATA_DIR = join(PROJECT_DIR, 'data');
const PERIOD_FILE = join(DATA_DIR, 'period.json');
const VALID_PERIODS = ['7d', '30d', '90d', 'all'];

function readPeriod() {
  if (existsSync(PERIOD_FILE)) {
    const val = JSON.parse(readFileSync(PERIOD_FILE, 'utf8')).period;
    if (VALID_PERIODS.includes(val)) return val;
  }
  return '30d';
}

function writePeriod(val) {
  if (!VALID_PERIODS.includes(val)) return false;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PERIOD_FILE, JSON.stringify({ period: val }));
  return true;
}

const ARCHIVE_FILE = join(DATA_DIR, 'correspondence-archive.json');
function readArchive() {
  if (!existsSync(ARCHIVE_FILE)) return {};
  const data = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8'));
  // Migrate from old array format
  if (Array.isArray(data.archived)) {
    const map = {};
    data.archived.forEach(url => { map[url] = { title: url, lastCommentAt: null }; });
    return map;
  }
  const raw = data.archived || {};
  // Migrate from old string-value format to { title, lastCommentAt }
  for (const url of Object.keys(raw)) {
    if (typeof raw[url] === 'string') raw[url] = { title: raw[url], lastCommentAt: null };
  }
  return raw;
}
function writeArchive(map) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ARCHIVE_FILE, JSON.stringify({ archived: map }));
}

const UNIMPORTANT_FILE = join(DATA_DIR, 'correspondence-unimportant.json');
function readUnimportant() {
  if (!existsSync(UNIMPORTANT_FILE)) return {};
  const data = JSON.parse(readFileSync(UNIMPORTANT_FILE, 'utf8'));
  return data.items || {};
}
function writeUnimportant(map) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(UNIMPORTANT_FILE, JSON.stringify({ items: map }));
}

const MARKED_IMPORTANT_FILE = join(DATA_DIR, 'correspondence-important.json');
function readMarkedImportant() {
  if (!existsSync(MARKED_IMPORTANT_FILE)) return [];
  return JSON.parse(readFileSync(MARKED_IMPORTANT_FILE, 'utf8')).urls || [];
}
function writeMarkedImportant(urls) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MARKED_IMPORTANT_FILE, JSON.stringify({ urls }));
}

const AUTO_UNARCHIVED_FILE = join(DATA_DIR, 'auto-unarchived.json');
function readAutoUnarchived() {
  if (!existsSync(AUTO_UNARCHIVED_FILE)) return [];
  return JSON.parse(readFileSync(AUTO_UNARCHIVED_FILE, 'utf8')).urls || [];
}
function writeAutoUnarchived(urls) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(AUTO_UNARCHIVED_FILE, JSON.stringify({ urls }));
}

function periodToSince(period) {
  if (period === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Global safety net: log unhandled rejections instead of crashing
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

const installedIDEs = await detectIDEs();
console.log(`Detected IDEs: ${installedIDEs.map(ide => ide.name).join(', ') || 'none'}`);

// Capture tool versions at startup for error diagnostics
let ghVersion = 'unknown';
let claudeVersion = 'unknown';
runCmd('gh', ['--version']).then(version => { ghVersion = version.match(/\d+\.\d+\.\d+/)?.[0] || version.trim(); });
runCmd('claude', ['--version']).then(version => { claudeVersion = version.trim(); });

// Store PR data between phases
let pendingPRData = null;
let ghUsername = null;
let enqueueAIItems = null;
let repoColorMap = loadRepoColors();
let cloneIndex = null;

// === Utilities ===

function handlePost(req, res, handler) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    // eslint-disable-next-line no-restricted-syntax -- top-level POST handler: catches all errors and sends { error } as HTTP 500 to FE
    try {
      await handler(JSON.parse(body));
    } catch (err) {
      console.error(`${req.url} failed:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// === Version Check ===

async function checkForUpdates() {
  await runCmd('git', ['fetch', 'origin', '--quiet']);
  const local = await runCmd('git', ['rev-parse', 'HEAD']);
  const remote = await runCmd('git', ['rev-parse', 'origin/main']);
  if (local !== remote) {
    const behind = parseInt(await runCmd('git', ['rev-list', '--count', `${local}..${remote}`]));
    if (behind > 0) {
      const log = await runCmd('git', ['log', '--format=%h %s%n%b%n---', `${local}..${remote}`]);
      const commits = log.split('\n---\n').map(line => line.trim()).filter(Boolean);
      return { behind, local: local.slice(0, 7), remote: remote.slice(0, 7), commits };
    }
    const ahead = parseInt(await runCmd('git', ['rev-list', '--count', `${remote}..${local}`]));
    if (ahead > 0) {
      return { ahead, local: local.slice(0, 7), remote: remote.slice(0, 7) };
    }
  }
  return null;
}

// === SSE: Phase 1 - Fetch PR data, send dashboard HTML ===

async function handleStatusStream(req, res) {
  const logsOnly = new URL(req.url, 'http://localhost').searchParams.has('logs');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  req.on('close', () => { closed = true; setCmdLogHook(null); });

  function log(message, type = 'info') {
    if (closed) return;
    res.write(`event: log\ndata: ${JSON.stringify({ message, type })}\n\n`);
  }

  setCmdLogHook((entry) => {
    if (closed) return;
    const dur = entry.duration < 1000 ? `${entry.duration}ms` : `${(entry.duration / 1000).toFixed(1)}s`;
    const status = entry.ok ? 'OK' : 'FAIL';
    log(`[${status} ${dur}] ${entry.cmd}`, entry.ok ? 'info' : 'error');
  });

  // eslint-disable-next-line no-restricted-syntax -- top-level SSE handler: catches all errors and sends fatal SSE event to FE
  try {
    resetCommandLog();
    const period = readPeriod();
    const since = periodToSince(period);
    const sinceQuery = since || '2000-01-01';

    const [myPRs, reviewPRs, rawMentionedPRs, username, assignedIssues, rawMentionedIssues, rawCreatedIssues, rawCommentedPRs, rawCommentedIssues, updateInfo, cloneIdx] = await Promise.all([
      fetchMyPRs(log),
      fetchReviewPRs(log),
      fetchMentionedPRs(log, sinceQuery),
      gh('api', 'user', '--jq', '.login').then(login => login.trim()),
      fetchAssignedIssues(log),
      fetchMentionedIssues(log, sinceQuery),
      fetchCreatedIssues(log),
      fetchCommentedPRs(log, sinceQuery),
      fetchCommentedIssues(log, sinceQuery),
      checkForUpdates(),
      buildCloneIndex(log),
    ]);
    ghUsername = username;
    cloneIndex = cloneIdx;

    // Deduplicate: remove mentioned PRs already in my PRs or review PRs
    const existingUrls = new Set([...myPRs, ...reviewPRs].map(pr => pr.html_url));
    const mentionedPRs = rawMentionedPRs.filter(pr => !existingUrls.has(pr.html_url));
    if (rawMentionedPRs.length !== mentionedPRs.length) {
      log(`Deduplicated: ${rawMentionedPRs.length - mentionedPRs.length} mentioned PRs already in other sections`, 'info');
    }

    // Deduplicate issues: remove mentioned/created that overlap with assigned
    const assignedIssueUrls = new Set(assignedIssues.map(issue => issue.html_url));
    const mentionedIssues = rawMentionedIssues.filter(issue => !assignedIssueUrls.has(issue.html_url));
    const createdIssuesDeduped = rawCreatedIssues.filter(issue => !assignedIssueUrls.has(issue.html_url) && !mentionedIssues.some(mentioned => mentioned.html_url === issue.html_url));

    // Commented PRs/Issues: remove self-authored and already-mentioned
    const mentionedPRUrls = new Set(mentionedPRs.map(pr => pr.html_url));
    const commentedPRs = rawCommentedPRs.filter(pr => pr.author !== username && !existingUrls.has(pr.html_url) && !mentionedPRUrls.has(pr.html_url));
    const mentionedIssueUrls = new Set(mentionedIssues.map(issue => issue.html_url));
    const commentedIssues = rawCommentedIssues.filter(issue => !assignedIssueUrls.has(issue.html_url) && !mentionedIssueUrls.has(issue.html_url));

    const archivedUrls = readArchive();

    const allPRs = [
      ...myPRs.map(pr => ({ ...pr, section: 'mine' })),
      ...reviewPRs.map(pr => ({ ...pr, section: 'review' })),
    ];

    const allIssues = [
      ...assignedIssues.map(issue => ({ ...issue, section: 'assigned-issue', isIssue: true })),
      ...createdIssuesDeduped.map(issue => ({ ...issue, section: 'created-issue', isIssue: true })),
    ];

    const allCorrespondence = [
      ...mentionedPRs.map(pr => ({ ...pr, section: 'mentioned' })),
      ...commentedPRs.map(pr => ({ ...pr, section: 'commented-pr' })),
      ...mentionedIssues.map(issue => ({ ...issue, section: 'mentioned-issue', isIssue: true })),
      ...commentedIssues.map(issue => ({ ...issue, section: 'commented-issue', isIssue: true })),
    ];

    allPRs.forEach(pr => { pr.days = daysSince(pr.updated_at); });
    allIssues.forEach(issue => { issue.days = daysSince(issue.updated_at); });
    allCorrespondence.forEach(item => { item.days = daysSince(item.updated_at); });

    log('Rendering dashboard...', 'success');

    // Store all items for phase 2 (AI streaming)
    const allItems = [...allPRs, ...allIssues, ...allCorrespondence];
    pendingPRData = allItems;

    // Update persistent repo color assignments
    const allRepoNames = [...new Set(allItems.map(item => item.repo.split('/').pop()))];
    repoColorMap = updateRepoColors(allRepoNames);

    const date = todayStr();
    const myPRsForHtml = allPRs.filter(pr => pr.section === 'mine');
    const reviewPRsForHtml = allPRs.filter(pr => pr.section === 'review');
    const assignedIssuesForHtml = allIssues.filter(issue => issue.section === 'assigned-issue');
    const createdIssuesForHtml = allIssues.filter(issue => issue.section === 'created-issue');
    const mentionedPRsForHtml = allCorrespondence.filter(item => item.section === 'mentioned');
    const commentedPRsForHtml = allCorrespondence.filter(item => item.section === 'commented-pr');
    const mentionedIssuesForHtml = allCorrespondence.filter(item => item.section === 'mentioned-issue');
    const commentedIssuesForHtml = allCorrespondence.filter(item => item.section === 'commented-issue');
    const autoUnarchivedUrls = readAutoUnarchived();
    const unimportantUrls = readUnimportant();
    const markedImportantUrls = readMarkedImportant();
    const html = buildDashboardHtml(myPRsForHtml, reviewPRsForHtml, assignedIssuesForHtml, createdIssuesForHtml, mentionedPRsForHtml, commentedPRsForHtml, mentionedIssuesForHtml, commentedIssuesForHtml, date, updateInfo, { repoColorMap, installedIDEs, period, ghUsername, archivedUrls, autoUnarchivedUrls, unimportantUrls, markedImportantUrls });

    setCmdLogHook(null);
    const cmdLog = getCommandLog();
    const totalDuration = cmdLog.reduce((sum, e) => sum + e.duration, 0);
    log(`Done: ${cmdLog.length} system calls, total ${(totalDuration / 1000).toFixed(1)}s`, 'success');

    if (!closed) {
      if (logsOnly) {
        res.write(`event: logs-done\ndata: {}\n\n`);
      } else {
        res.write(`event: done\ndata: ${JSON.stringify({ html })}\n\n`);
      }
      res.end();
    }
  } catch (err) {
    setCmdLogHook(null);
    console.error('Fatal status stream error:', err);
    const errDetail = `${err.stack || err.message}\n\n[gh ${ghVersion}]`;
    log(`Error: ${errDetail}`, 'error');
    if (!closed) {
      res.write(`event: fatal\ndata: ${JSON.stringify({ error: errDetail })}\n\n`);
      res.end();
    }
  }
}

// === Server ===

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(INDEX_HTML);
  } else if (pathname === '/api/status' && req.method === 'GET') {
    handleStatusStream(req, res);
  } else if (pathname === '/api/ai-stream' && req.method === 'GET') {
    handleAIStream(req, res, {
      allItems: pendingPRData,
      ghUsername,
      ghVersion,
      claudeVersion,
      onEnqueueReady: (callback) => { enqueueAIItems = callback; },
      archivedUrls: readArchive(),
      onAutoUnarchive: (url) => {
        const map = readArchive();
        delete map[url];
        writeArchive(map);
        const autoUnarchived = readAutoUnarchived();
        if (!autoUnarchived.includes(url)) { autoUnarchived.push(url); writeAutoUnarchived(autoUnarchived); }
      },
      clearAutoUnarchived: () => writeAutoUnarchived([]),
      onMarkUnimportant: (url, title, lastCommentAt) => {
        if (readMarkedImportant().includes(url)) return;
        const map = readUnimportant();
        map[url] = { title: title || url, lastCommentAt: lastCommentAt || null };
        writeUnimportant(map);
      },
      unimportantUrls: readUnimportant(),
      onResetUnimportant: (url) => {
        const map = readUnimportant();
        delete map[url];
        writeUnimportant(map);
        const markedImportant = readMarkedImportant().filter(itemUrl => itemUrl !== url);
        writeMarkedImportant(markedImportant);
      },
    });
  } else if (pathname === '/api/ai-enqueue' && req.method === 'POST') {
    handlePost(req, res, (data) => {
      const { indices } = data;
      if (enqueueAIItems && Array.isArray(indices)) enqueueAIItems(indices);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  } else if (pathname === '/api/chat' && req.method === 'POST') {
    handlePost(req, res, async (data) => {
      const { index, action, clonePath } = data;
      const pr = pendingPRData && pendingPRData[index];
      if (!pr) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found. Reload the page.' })); return; }

      await launchChat({
        prompt: pr.chatContext || '',
        url: pr.html_url,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        isIssue: pr.isIssue,
        branch: pr.details?.headRefName || '',
        aiStatus: pr.aiStatus || '',
        action: action || 'chat-here',
        clonePath: clonePath || '',
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  } else if (pathname === '/api/repo-scan' && req.method === 'POST') {
    handlePost(req, res, async (data) => {
      const { index, rescan } = data;
      const pr = pendingPRData && pendingPRData[index];
      if (!pr) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found. Reload the page.' })); return; }

      if (rescan) cloneIndex = await buildCloneIndex();

      const scanResult = await scanForClones(
        pr.repo,
        pr.isIssue ? null : (pr.details?.headRefName || null),
        pr.isIssue ? null : (pr.details?.headRefOid || null),
        cloneIndex || new Map()
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...scanResult,
        title: pr.title,
        number: pr.number,
        isIssue: pr.isIssue,
        url: pr.html_url,
        aiStatus: pr.aiStatus || '',
      }));
    });
  } else if (pathname === '/api/repo-sync' && req.method === 'POST') {
    handlePost(req, res, async (data) => {
      const { action, clonePath, branch } = data;
      if (!clonePath) { res.writeHead(400); res.end(JSON.stringify({ error: 'No clone path.' })); return; }
      if (action === 'checkout' && branch) {
        await runCmd('git', ['fetch', 'origin'], { cwd: clonePath });
        await runCmd('git', ['checkout', branch], { cwd: clonePath });
      } else if (action === 'pull' && branch) {
        await runCmd('git', ['fetch', 'origin', branch], { cwd: clonePath });
        const localHead = (await runCmd('git', ['rev-parse', `refs/heads/${branch}`], { cwd: clonePath }).catch(() => '')).trim();
        const remoteHead = (await runCmd('git', ['rev-parse', `refs/remotes/origin/${branch}`], { cwd: clonePath }).catch(() => '')).trim();
        if (await checkDivergence(clonePath, localHead, remoteHead) === 'diverged') {
          cloneIndex = await buildCloneIndex();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ diverged: true }));
          return;
        }
        await runCmd('git', ['pull', 'origin', branch], { cwd: clonePath });
      } else {
        res.writeHead(400); res.end(JSON.stringify({ error: `Unknown sync action: ${action}` })); return;
      }
      cloneIndex = await buildCloneIndex();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  } else if (pathname === '/api/open-ide' && req.method === 'POST') {
    handlePost(req, res, (data) => {
      const { cmd, clonePath } = data;
      const ide = installedIDEs.find(entry => entry.cmd === cmd);
      if (!ide) { res.writeHead(400); res.end(JSON.stringify({ error: `IDE "${cmd}" not found.` })); return; }
      if (!clonePath) { res.writeHead(400); res.end(JSON.stringify({ error: 'No clone path provided.' })); return; }

      spawn(ide.cmd, [clonePath], { stdio: 'ignore', detached: true }).unref();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  } else if (pathname === '/api/correspondence-archive' && req.method === 'GET') {
    const archived = readArchive();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ archived }));
  } else if (pathname === '/api/correspondence-archive' && req.method === 'POST') {
    handlePost(req, res, (data) => {
      const { url, action, title, lastCommentAt } = data;
      if (!url || !['archive', 'unarchive'].includes(action)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid url or action' }));
        return;
      }
      const map = readArchive();
      if (action === 'archive') {
        map[url] = { title: title || url, lastCommentAt: lastCommentAt || null };
        const autoUnarchived = readAutoUnarchived().filter(itemUrl => itemUrl !== url);
        writeAutoUnarchived(autoUnarchived);
      } else {
        delete map[url];
      }
      writeArchive(map);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, archivedCount: Object.keys(map).length }));
    });
  } else if (pathname === '/api/correspondence-unimportant' && req.method === 'GET') {
    const items = readUnimportant();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
  } else if (pathname === '/api/correspondence-unimportant' && req.method === 'POST') {
    handlePost(req, res, (data) => {
      const { url, action } = data;
      if (!url || action !== 'mark-important') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid url or action' }));
        return;
      }
      const map = readUnimportant();
      delete map[url];
      writeUnimportant(map);
      const markedImportant = readMarkedImportant();
      if (!markedImportant.includes(url)) { markedImportant.push(url); writeMarkedImportant(markedImportant); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, unimportantCount: Object.keys(map).length }));
    });
  } else if (pathname === '/api/period' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ period: readPeriod() }));
  } else if (pathname === '/api/period' && req.method === 'POST') {
    handlePost(req, res, (data) => {
      if (!writePeriod(data.period)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid period' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  } else if (pathname.startsWith('/public/') && req.method === 'GET') {
    const filePath = join(PROJECT_DIR, pathname);
    if (!filePath.startsWith(join(PROJECT_DIR, 'public'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (!existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const content = readFileSync(filePath, 'utf8');
    const ext = filePath.split('.').pop();
    const mimeTypes = { js: 'application/javascript', css: 'text/css', html: 'text/html' };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`GitHub Status server running at http://localhost:${PORT}`);
});
