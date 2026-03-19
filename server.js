import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(execFile);
const PORT = process.env.PORT || 7777;

// === Helpers ===

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function daysSince(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function daysClass(days) {
  if (days <= 3) return 'good';
  if (days <= 14) return 'warning';
  return 'bad';
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function gh(...args) {
  const { stdout } = await execAsync('gh', args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Store PR data between phases
let pendingPRData = null;
let ghUsername = null;

// === Data Fetching ===

async function fetchMyPRs(log) {
  log('Fetching my open PRs...', 'info');
  const raw = await gh('api', 'search/issues?q=author:@me+type:pr+state:open&per_page=100');
  const data = JSON.parse(raw);
  const prs = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    updated_at: item.updated_at,
  }));
  log(`Found ${prs.length} open PRs`, 'success');
  return prs;
}

async function fetchReviewPRs(log) {
  log('Fetching PRs awaiting my review...', 'info');
  const raw = await gh('api', 'search/issues?q=review-requested:@me+type:pr+state:open&per_page=100');
  const data = JSON.parse(raw);
  const prs = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    author: item.user.login,
    updated_at: item.updated_at,
  }));
  log(`Found ${prs.length} PRs awaiting review`, 'success');
  return prs;
}

async function fetchMentionedPRs(log) {
  log('Fetching PRs I was mentioned in (last 30 days)...', 'info');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const raw = await gh('api', `search/issues?q=mentions:@me+type:pr+updated:>${since}&per_page=100&sort=updated&order=desc`);
  const data = JSON.parse(raw);
  const prs = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    author: item.user.login,
    updated_at: item.updated_at,
    state: item.pull_request?.merged_at ? 'merged' : item.state,
  }));
  log(`Found ${prs.length} mentioned PRs`, 'success');
  return prs;
}

async function fetchPRDetails(repo, number) {
  const [detailsRaw, diffRaw] = await Promise.all([
    gh('pr', 'view', String(number), '--repo', repo,
      '--json', 'reviewDecision,statusCheckRollup,comments,reviews,updatedAt,isDraft,mergeable,labels,body'),
    gh('pr', 'diff', String(number), '--repo', repo).catch(() => '(diff unavailable)'),
  ]);
  const details = JSON.parse(detailsRaw);
  details.diff = diffRaw.length > 20000 ? diffRaw.slice(0, 20000) + '\n... (truncated)' : diffRaw;
  return details;
}

// === AI Status Generation (streaming per-PR) ===

function buildPromptForPR(pr) {
  const d = pr.details || {};

  const comments = (d.comments || [])
    .filter(c => c.author?.login !== 'coderabbitai')
    .map(c => `@${c.author?.login}: ${c.body?.slice(0, 300)}`);

  const reviews = (d.reviews || [])
    .map(r => `@${r.author?.login}: ${r.state} - ${(r.body || '').slice(0, 200)}`);

  const checks = (d.statusCheckRollup || []).map(c => ({
    name: c.name || c.context || '',
    state: c.state || c.conclusion || c.status || '',
    url: c.detailsUrl || c.targetUrl || '',
  }));

  const typeMap = { mine: 'My PR', review: 'Review requested from me', mentioned: 'Mentioned in this PR' };

  const sections = [
    `Title: ${pr.title}`,
    `Repo: ${pr.repo}`,
    `Type: ${typeMap[pr.section] || 'Unknown'}`,
    pr.state ? `PR State: ${pr.state}` : null,
    `Draft: ${d.isDraft || false}`,
    `Review decision: ${d.reviewDecision || 'NONE'}`,
    `Mergeable: ${d.mergeable || 'UNKNOWN'}`,
    `Labels: ${(d.labels || []).map(l => l.name).join(', ') || 'none'}`,
    `Days since last update: ${pr.days}`,
    `\nCI Checks:\n${checks.length ? checks.map(c => `  ${c.state} ${c.name} ${c.url}`).join('\n') : '  (none)'}`,
    `\nReviews:\n${reviews.length ? reviews.join('\n') : '  (none)'}`,
    `\nComments (excluding bots):\n${comments.length ? comments.join('\n') : '  (none)'}`,
    `\nPR Body:\n${(d.body || '(empty)').slice(0, 1000)}`,
    `\nDiff:\n${d.diff || '(unavailable)'}`,
  ].filter(Boolean);

  const mentionedRules = `
- My GitHub username is: ${ghUsername}
- For mentioned PRs: assess whether MY response or action is still needed
- If I (${ghUsername}) have already commented or reviewed on this PR, start statusText with "RESPONDED. " and use statusClass "good"
- good: I already responded, conversation resolved, PR merged/closed, or no action needed from me
- warning: Conversation is ongoing and may need my input
- bad: I was asked a question or requested an action and haven't responded`;

  const standardRules = `
- good: Approved + CI green/no CI = ready to merge
- warning: Awaiting review with CI passing/no CI, or approved with CI failures, or CI still running
- bad: CI failures without approval, or stale 50+ days
- Name specific failing CI checks in statusText
- For review-requested PRs: focus on what the reviewer needs to know`;

  const rules = pr.section === 'mentioned' ? mentionedRules : standardRules;

  return `You are a JSON API. Analyze this GitHub PR and return ONLY a single JSON object (no markdown fences, no explanation).

${sections.join('\n')}

Return: {"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>","ciUrl":"<failing CI URL or null>"}

Rules:${rules}`;
}

// === HTML Generation ===

function buildDashboardHtml(myPRs, reviewPRs, mentionedPRs, date) {
  function stateBadge(state) {
    if (!state) return '';
    const colors = { open: '#3fb950', merged: '#a371f7', closed: '#f85149' };
    const color = colors[state] || '#8b949e';
    return ` <span class="state-badge" style="color:${color};border-color:${color}">${state}</span>`;
  }

  function prRow(pr, includeAuthor, globalIndex, includeState) {
    const repoShort = pr.repo.split('/').pop();
    const authorSpan = includeAuthor ? ` <span class="author">@${escapeHtml(pr.author)}</span>` : '';
    const stateSpan = includeState ? stateBadge(pr.state) : '';
    return `            <tr>
                <td class="title-col"><span class="repo-badge">${escapeHtml(repoShort)}</span>${escapeHtml(pr.title)}${authorSpan}${stateSpan}</td>
                <td class="link-col"><a href="${escapeHtml(pr.html_url)}">#${pr.number}</a></td>
                <td class="status-col" id="status-${globalIndex}">
                    <a href="#" class="ai-toggle" data-index="${globalIndex}" onclick="toggleLog(${globalIndex});return false">generating...</a>
                    <div class="ai-log" id="ai-log-${globalIndex}"></div>
                </td>
                <td class="days-col days-${daysClass(pr.days)}">${pr.days}d</td>
            </tr>`;
  }

  let idx = 0;
  const myRows = myPRs.map(pr => prRow(pr, false, idx++, false)).join('\n');
  const reviewRows = reviewPRs.map(pr => prRow(pr, true, idx++, false)).join('\n');
  const mentionedRows = mentionedPRs.map(pr => prRow(pr, true, idx++, true)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitHub Status - ${date}</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            max-width: 1600px;
            margin: 0 auto;
            padding: 10px;
            background-color: #0d1117;
            color: #c9d1d9;
        }
        h1 { font-size: 16px; margin: 0 0 12px 0; color: #c9d1d9; }
        h2 { font-size: 13px; margin: 16px 0 6px 0; color: #8b949e; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #21262d; vertical-align: top; }
        th { font-weight: 600; color: #8b949e; font-size: 11px; text-transform: uppercase; }
        tr:hover { background-color: #161b22; }
        a { color: #58a6ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .status-good { color: #3fb950; }
        .status-warning { color: #d29922; }
        .status-bad { color: #f85149; }
        .days-good { color: #3fb950; }
        .days-warning { color: #d29922; }
        .days-bad { color: #f85149; }
        .ci-link { color: #58a6ff; font-size: 11px; }
        .repo-badge { color: #58a6ff; margin-right: 4px; }
        .author { color: #8b949e; font-size: 11px; }
        .title-col { max-width: 400px; }
        .status-col { max-width: 500px; font-size: 11px; }
        .link-col { white-space: nowrap; }
        .days-col { white-space: nowrap; text-align: right; }
        .footer { color: #484f58; font-size: 11px; margin-top: 20px; }

        .state-badge { font-size: 10px; border: 1px solid; border-radius: 3px; padding: 1px 4px; margin-left: 4px; }
        .ai-toggle { cursor: pointer; color: #d29922; }
        .ai-toggle.done { cursor: default; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .ai-toggle.loading { animation: pulse 1.5s ease-in-out infinite; }
        .ai-log {
            display: none;
            margin-top: 4px;
            padding: 6px 8px;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 4px;
            font-size: 11px;
            color: #8b949e;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }
        .ai-log.visible { display: block; }
    </style>
</head>
<body>
    <h1>GitHub Status - ${date}</h1>

    <h2>My Open PRs (${myPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Title</th>
                <th class="link-col">Link</th>
                <th>Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${myRows}
        </tbody>
    </table>

    <h2>PRs Waiting for My Review (${reviewPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Title</th>
                <th class="link-col">Link</th>
                <th>Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${reviewRows}
        </tbody>
    </table>

    <h2>PRs I Was Mentioned In (${mentionedPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Title</th>
                <th class="link-col">Link</th>
                <th>Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${mentionedRows}
        </tbody>
    </table>

    <p class="footer">Generated ${date}</p>

    <script>
        function toggleLog(index) {
            var el = document.getElementById('ai-log-' + index);
            el.classList.toggle('visible');
        }

        // Connect to AI status stream
        var es = new EventSource('/api/ai-stream');
        var completed = 0;
        var total = ${myPRs.length + reviewPRs.length + mentionedPRs.length};

        es.addEventListener('ai-log', function(e) {
            var d = JSON.parse(e.data);
            var log = document.getElementById('ai-log-' + d.index);
            log.textContent += d.text;
            log.scrollTop = log.scrollHeight;
        });

        es.addEventListener('ai-done', function(e) {
            var d = JSON.parse(e.data);
            var cell = document.getElementById('status-' + d.index);
            var ciLink = d.ciUrl ? ' <a class="ci-link" href="' + d.ciUrl + '">[link]</a>' : '';
            // Keep the log div, replace the toggle link with final status
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\n--- Result ---\\n' + JSON.stringify({statusText: d.statusText, statusClass: d.statusClass, ciUrl: d.ciUrl}, null, 2);
            cell.className = 'status-col status-' + d.statusClass;
            cell.innerHTML = '<a href="#" class="ai-toggle done" onclick="toggleLog(' + d.index + ');return false">' +
                d.statusText.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a>' + ciLink +
                '<div class="ai-log' + (logDiv.classList.contains('visible') ? ' visible' : '') + '" id="ai-log-' + d.index + '">' + logDiv.innerHTML + '</div>';
            completed++;
            if (completed >= total) es.close();
        });

        es.addEventListener('ai-error', function(e) {
            var d = JSON.parse(e.data);
            var cell = document.getElementById('status-' + d.index);
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\nERROR: ' + d.error;
            cell.className = 'status-col status-warning';
            cell.innerHTML = '<a href="#" class="ai-toggle done" onclick="toggleLog(' + d.index + ');return false">Failed to generate status</a>' +
                '<div class="ai-log' + (logDiv.classList.contains('visible') ? ' visible' : '') + '" id="ai-log-' + d.index + '">' + logDiv.innerHTML + '</div>';
            completed++;
            if (completed >= total) es.close();
        });

        es.onerror = function() {
            if (es.readyState === EventSource.CLOSED) return;
            es.close();
        };

        // Auto-expand first loading status
        document.querySelectorAll('.ai-toggle.loading').forEach(function(el) {
            el.classList.add('loading');
        });
        document.querySelectorAll('.ai-toggle').forEach(function(el) {
            el.classList.add('loading');
        });
    </script>
</body>
</html>`;
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
    const [myPRs, reviewPRs, rawMentionedPRs, username] = await Promise.all([
      fetchMyPRs(log),
      fetchReviewPRs(log),
      fetchMentionedPRs(log),
      gh('api', 'user', '--jq', '.login').then(s => s.trim()),
    ]);
    ghUsername = username;

    // Deduplicate: remove mentioned PRs already in my PRs or review PRs
    const existingUrls = new Set([...myPRs, ...reviewPRs].map(pr => pr.html_url));
    const mentionedPRs = rawMentionedPRs.filter(pr => !existingUrls.has(pr.html_url));
    if (rawMentionedPRs.length !== mentionedPRs.length) {
      log(`Deduplicated: ${rawMentionedPRs.length - mentionedPRs.length} mentioned PRs already in other sections`, 'info');
    }

    const allPRs = [
      ...myPRs.map(pr => ({ ...pr, section: 'mine' })),
      ...reviewPRs.map(pr => ({ ...pr, section: 'review' })),
      ...mentionedPRs.map(pr => ({ ...pr, section: 'mentioned' })),
    ];

    log(`Fetching details for ${allPRs.length} PRs in parallel...`, 'info');

    const detailResults = await Promise.allSettled(
      allPRs.map(async (pr) => {
        log(`  → ${pr.repo}#${pr.number}`, 'info');
        return fetchPRDetails(pr.repo, pr.number);
      })
    );

    detailResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allPRs[i].details = result.value;
      } else {
        log(`Failed: ${allPRs[i].repo}#${allPRs[i].number}: ${result.reason?.message}`, 'error');
        allPRs[i].details = null;
      }
      allPRs[i].days = daysSince(allPRs[i].updated_at);
    });

    log('All PR details fetched. Rendering dashboard...', 'success');

    // Store PR data for phase 2
    pendingPRData = allPRs;

    const date = todayStr();
    const myPRsForHtml = allPRs.filter(pr => pr.section === 'mine');
    const reviewPRsForHtml = allPRs.filter(pr => pr.section === 'review');
    const mentionedPRsForHtml = allPRs.filter(pr => pr.section === 'mentioned');
    const html = buildDashboardHtml(myPRsForHtml, reviewPRsForHtml, mentionedPRsForHtml, date);

    if (!closed) {
      res.write(`event: done\ndata: ${JSON.stringify({ html })}\n\n`);
      res.end();
    }
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    if (!closed) {
      res.write(`event: fatal\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
}

// === SSE: Phase 2 - Stream AI status generation per PR ===

function handleAIStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  req.on('close', () => { closed = true; });

  function send(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  if (!pendingPRData) {
    send('ai-error', { index: 0, error: 'No PR data available. Reload the page.' });
    res.end();
    return;
  }

  const allPRs = pendingPRData;
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const CONCURRENCY = 19;

  function runOne(index) {
    return new Promise((resolve) => {
      const pr = allPRs[index];
      const prompt = buildPromptForPR(pr);

      send('ai-log', { index, text: `=== Prompt ===\n${prompt}\n\n=== Claude Output ===\n` });

      const child = spawn('claude', ['-p', '--model', 'haiku'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Send prompt via stdin instead of CLI arg (avoids OS arg length limits)
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        send('ai-log', { index, text });
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        send('ai-log', { index, text: `[stderr] ${text}` });
      });

      child.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
          send('ai-error', { index, error: stderr || `Exit code ${code}` });
        } else {
          try {
            const text = stdout.trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            const status = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            send('ai-done', {
              index,
              statusText: status.statusText || 'Unknown',
              statusClass: status.statusClass || 'warning',
              ciUrl: status.ciUrl || null,
            });
          } catch (e) {
            send('ai-error', { index, error: `Parse error: ${e.message}\nRaw: ${stdout}` });
          }
        }
        resolve();
      });

      child.on('error', (err) => {
        send('ai-error', { index, error: err.message });
        resolve();
      });
    });
  }

  // Run with bounded concurrency
  async function runAll() {
    const queue = allPRs.map((_, i) => i);
    const running = new Set();

    while (queue.length > 0 || running.size > 0) {
      while (queue.length > 0 && running.size < CONCURRENCY) {
        const idx = queue.shift();
        const p = runOne(idx).then(() => running.delete(p));
        running.add(p);
      }
      if (running.size > 0) await Promise.race(running);
    }

    if (!closed) res.end();
  }

  runAll();
}

// === Index Page ===

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitHub Status</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'JetBrains Mono', monospace;
            background: #0d1117;
            color: #c9d1d9;
            padding: 10px;
            font-size: 12px;
        }
        h1 { font-size: 16px; margin-bottom: 12px; color: #c9d1d9; }
        #logs { line-height: 1.8; }
        .log-line { white-space: pre-wrap; }
        .log-info { color: #8b949e; }
        .log-success { color: #3fb950; }
        .log-error { color: #f85149; }
    </style>
</head>
<body>
    <h1>GitHub Status</h1>
    <div id="logs"></div>
    <script>
        var logs = document.getElementById('logs');
        var es = new EventSource('/api/status');

        function addLog(msg, type) {
            var line = document.createElement('div');
            line.className = 'log-line log-' + type;
            var t = new Date().toLocaleTimeString('en-US', { hour12: false });
            line.textContent = '[' + t + '] ' + msg;
            logs.appendChild(line);
            window.scrollTo(0, document.body.scrollHeight);
        }

        es.addEventListener('log', function(e) {
            var data = JSON.parse(e.data);
            addLog(data.message, data.type);
        });

        es.addEventListener('done', function(e) {
            es.close();
            var data = JSON.parse(e.data);
            document.open();
            document.write(data.html);
            document.close();
        });

        es.addEventListener('fatal', function(e) {
            es.close();
            var data = JSON.parse(e.data);
            addLog('FATAL: ' + data.error, 'error');
        });

        es.onerror = function() {
            if (es.readyState === EventSource.CLOSED) return;
            es.close();
            addLog('Connection lost', 'error');
        };

        addLog('Connecting...', 'info');
    </script>
</body>
</html>`;

// === Server ===

const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(INDEX_HTML);
  } else if (req.url === '/api/status' && req.method === 'GET') {
    handleStatusStream(req, res);
  } else if (req.url === '/api/ai-stream' && req.method === 'GET') {
    handleAIStream(req, res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`GitHub Status server running at http://localhost:${PORT}`);
});
