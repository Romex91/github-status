import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCmd, gh, daysSince, todayStr } from './helpers.js';
import { loadRepoColors, updateRepoColors } from './repo-colors.js';
import { fetchMyPRs, fetchReviewPRs, fetchMentionedPRs, fetchAssignedIssues, fetchMentionedIssues, fetchCreatedIssues } from './github-api.js';
import { handleAIStream } from './ai-status.js';
import { INDEX_HTML, buildDashboardHtml } from './dashboard-html.js';
import { launchChat } from './launch-chat.js';
import { scanForClones } from './repo-scan.js';
import { detectIDEs } from './ide-detect.js';

const PROJECT_DIR = new URL('.', import.meta.url).pathname;
const PORT = process.env.PORT || 7777;

const installedIDEs = detectIDEs();
console.log(`Detected IDEs: ${installedIDEs.map(i => i.name).join(', ') || 'none'}`);

// Capture tool versions at startup for error diagnostics
let ghVersion = 'unknown';
let claudeVersion = 'unknown';
runCmd('gh', ['--version']).then(v => { ghVersion = v.match(/\d+\.\d+\.\d+/)?.[0] || v.trim(); }).catch(() => {});
runCmd('claude', ['--version']).then(v => { claudeVersion = v.trim(); }).catch(() => {});

// Store PR data between phases
let pendingPRData = null;
let ghUsername = null;
let enqueueAIItems = null;
let repoColorMap = loadRepoColors();

// === Version Check ===

async function checkForUpdates() {
  try {
    try { await runCmd('git', ['fetch', 'origin', '--quiet']); } catch {} // fetch has no stdout, runCmd rejects on empty output
    const local = (await runCmd('git', ['rev-parse', 'HEAD'])).trim();
    const remote = (await runCmd('git', ['rev-parse', 'origin/main'])).trim();
    if (local !== remote) {
      const behind = (await runCmd('git', ['rev-list', '--count', `${local}..${remote}`])).trim();
      const log = (await runCmd('git', ['log', '--format=%h %s%n%b%n---', `${local}..${remote}`])).trim();
      const commits = log.split('\n---\n').map(l => l.trim()).filter(Boolean);
      return { behind: parseInt(behind), local: local.slice(0, 7), remote: remote.slice(0, 7), commits };
    }
  } catch (e) {
    console.error('Version check failed:', e.message);
  }
  return null;
}

// === SSE: Phase 1 - Fetch PR data, send dashboard HTML ===

async function handleStatusStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  req.on('close', () => { closed = true; });

  function log(message, type = 'info') {
    if (closed) return;
    res.write(`event: log\ndata: ${JSON.stringify({ message, type })}\n\n`);
  }

  try {
    const [myPRs, reviewPRs, rawMentionedPRs, username, assignedIssues, rawMentionedIssues, rawCreatedIssues, updateInfo] = await Promise.all([
      fetchMyPRs(log),
      fetchReviewPRs(log),
      fetchMentionedPRs(log),
      gh('api', 'user', '--jq', '.login').then(s => s.trim()),
      fetchAssignedIssues(log),
      fetchMentionedIssues(log),
      fetchCreatedIssues(log),
      checkForUpdates(),
    ]);
    ghUsername = username;

    // Deduplicate: remove mentioned PRs already in my PRs or review PRs
    const existingUrls = new Set([...myPRs, ...reviewPRs].map(pr => pr.html_url));
    const mentionedPRs = rawMentionedPRs.filter(pr => !existingUrls.has(pr.html_url));
    if (rawMentionedPRs.length !== mentionedPRs.length) {
      log(`Deduplicated: ${rawMentionedPRs.length - mentionedPRs.length} mentioned PRs already in other sections`, 'info');
    }

    // Deduplicate issues: remove mentioned/created that overlap with assigned
    const assignedIssueUrls = new Set(assignedIssues.map(i => i.html_url));
    const mentionedIssues = rawMentionedIssues.filter(i => !assignedIssueUrls.has(i.html_url));
    const createdIssuesDeduped = rawCreatedIssues.filter(i => !assignedIssueUrls.has(i.html_url) && !mentionedIssues.some(m => m.html_url === i.html_url));

    const allPRs = [
      ...myPRs.map(pr => ({ ...pr, section: 'mine' })),
      ...reviewPRs.map(pr => ({ ...pr, section: 'review' })),
      ...mentionedPRs.map(pr => ({ ...pr, section: 'mentioned' })),
    ];

    const allIssues = [
      ...assignedIssues.map(i => ({ ...i, section: 'assigned-issue', isIssue: true })),
      ...mentionedIssues.map(i => ({ ...i, section: 'mentioned-issue', isIssue: true })),
      ...createdIssuesDeduped.map(i => ({ ...i, section: 'created-issue', isIssue: true })),
    ];

    allPRs.forEach(pr => { pr.days = daysSince(pr.updated_at); });
    allIssues.forEach(issue => { issue.days = daysSince(issue.updated_at); });

    log('Rendering dashboard...', 'success');

    // Store all items for phase 2 (AI streaming)
    const allItems = [...allPRs, ...allIssues];
    pendingPRData = allItems;

    // Update persistent repo color assignments
    const allRepoNames = [...new Set(allItems.map(i => i.repo.split('/').pop()))];
    repoColorMap = updateRepoColors(allRepoNames);

    const date = todayStr();
    const myPRsForHtml = allPRs.filter(pr => pr.section === 'mine');
    const reviewPRsForHtml = allPRs.filter(pr => pr.section === 'review');
    const mentionedPRsForHtml = allPRs.filter(pr => pr.section === 'mentioned');
    const assignedIssuesForHtml = allItems.filter(i => i.section === 'assigned-issue');
    const mentionedIssuesForHtml = allItems.filter(i => i.section === 'mentioned-issue');
    const createdIssuesForHtml = allItems.filter(i => i.section === 'created-issue');
    const html = buildDashboardHtml(myPRsForHtml, reviewPRsForHtml, mentionedPRsForHtml, assignedIssuesForHtml, mentionedIssuesForHtml, createdIssuesForHtml, date, updateInfo, { repoColorMap, installedIDEs });

    if (!closed) {
      res.write(`event: done\ndata: ${JSON.stringify({ html })}\n\n`);
      res.end();
    }
  } catch (err) {
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
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(INDEX_HTML);
  } else if (req.url === '/api/status' && req.method === 'GET') {
    handleStatusStream(req, res);
  } else if (req.url === '/api/ai-stream' && req.method === 'GET') {
    handleAIStream(req, res, {
      allItems: pendingPRData,
      ghUsername,
      ghVersion,
      claudeVersion,
      onEnqueueReady: (fn) => { enqueueAIItems = fn; },
    });
  } else if (req.url === '/api/ai-enqueue' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { indices } = JSON.parse(body);
        if (enqueueAIItems && Array.isArray(indices)) enqueueAIItems(indices);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
  } else if (req.url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { index, action, clonePath } = JSON.parse(body);
        const pr = pendingPRData && pendingPRData[index];
        if (!pr) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found. Reload the page.' })); return; }

        launchChat({
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
      } catch (e) {
        console.error('Chat launch failed:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === '/api/repo-scan' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { index } = JSON.parse(body);
        const pr = pendingPRData && pendingPRData[index];
        if (!pr) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found. Reload the page.' })); return; }

        const scanResult = await scanForClones(
          pr.repo,
          pr.isIssue ? null : (pr.details?.headRefName || null),
          pr.isIssue ? null : (pr.details?.headRefOid || null)
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
      } catch (e) {
        console.error('Repo scan failed:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === '/api/repo-sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { action, clonePath, branch } = JSON.parse(body);
        if (!clonePath) { res.writeHead(400); res.end(JSON.stringify({ error: 'No clone path.' })); return; }
        if (action === 'checkout' && branch) {
          execSync(`git fetch origin`, { cwd: clonePath, encoding: 'utf8', timeout: 30000 });
          execSync(`git checkout ${branch}`, { cwd: clonePath, encoding: 'utf8', timeout: 10000 });
        } else if (action === 'pull') {
          execSync('git pull', { cwd: clonePath, encoding: 'utf8', timeout: 30000 });
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: `Unknown sync action: ${action}` })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('Repo sync failed:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === '/api/open-ide' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { cmd, clonePath } = JSON.parse(body);
        const ide = installedIDEs.find(i => i.cmd === cmd);
        if (!ide) { res.writeHead(400); res.end(JSON.stringify({ error: `IDE "${cmd}" not found.` })); return; }
        if (!clonePath) { res.writeHead(400); res.end(JSON.stringify({ error: 'No clone path provided.' })); return; }

        spawn(ide.cmd, [clonePath], { stdio: 'ignore', detached: true }).unref();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Open IDE failed:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url.startsWith('/public/') && req.method === 'GET') {
    const filePath = join(PROJECT_DIR, req.url);
    if (!filePath.startsWith(join(PROJECT_DIR, 'public'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      const ext = filePath.split('.').pop();
      const mimeTypes = { js: 'application/javascript', css: 'text/css', html: 'text/html' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`GitHub Status server running at http://localhost:${PORT}`);
});
