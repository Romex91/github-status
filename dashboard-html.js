import { escapeHtml, daysClass } from './helpers.js';

export const INDEX_HTML = `<!DOCTYPE html>
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
    <script>(function(){var o=console.error;function banner(){if(document.body&&!document.getElementById('_err')){var d=document.createElement('div');d.id='_err';d.style.cssText='background:#3d1f1f;color:#f85149;padding:6px 12px;font-size:12px;font-family:monospace;position:sticky;top:0;z-index:999;border-bottom:1px solid #f85149';d.textContent='There are errors in dev console';document.body.prepend(d)}}console.error=function(){o.apply(console,arguments);banner();setTimeout(banner,0)};window.onerror=function(m,s,l,c,e){o.call(console,e||m);banner();setTimeout(banner,0)};window.addEventListener('unhandledrejection',function(e){console.error(e.reason)})})()</script>
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

        function onSSE(source, event, handler) {
            source.addEventListener(event, function(e) {
                var d = JSON.parse(e.data);
                if (d.error) { console.error(d.error); return; }
                handler(d);
            });
        }

        onSSE(es, 'log', function(d) { addLog(d.message, d.type); });
        onSSE(es, 'done', function(d) {
            es.close();
            document.open();
            document.write(d.html);
            document.close();
            window.scrollTo(0, 0);
        });
        onSSE(es, 'fatal', function() {});

        es.onerror = function() {
            if (es.readyState === EventSource.CLOSED) return;
            es.close();
            console.error('Status stream connection lost');
        };

        addLog('Connecting...', 'info');
    </script>
</body>
</html>`;

export function buildDashboardHtml(myPRs, reviewPRs, assignedIssues, createdIssues, mentionedPRs, commentedPRs, mentionedIssues, commentedIssues, date, updateInfo, { repoColorMap, installedIDEs, period, ghUsername, archivedUrls }) {
  const archivedSet = new Set(Object.keys(archivedUrls || {}));
  function repoColor(repoName) {
    return repoColorMap[repoName] || '#8b949e';
  }

  function stateBadge(state) {
    if (!state) return '';
    const colors = { open: '#3fb950', merged: '#a371f7', closed: '#f85149' };
    const color = colors[state] || '#8b949e';
    return ` <span class="state-badge" style="color:${color};border-color:${color}">${state}</span>`;
  }

  function statusCell(item, globalIndex) {
    if (item.fetchError) {
      return `<td class="status-col status-bad">Fetch failed: ${escapeHtml(item.fetchError)}</td>`;
    }
    return `<td class="status-col" id="status-${globalIndex}">
                    <span class="status-text">waiting...</span>
                    <br><span id="inline-actions-${globalIndex}"></span>${item.isIssue ? '' : `<span class="action-btn action-btn-accent" onclick="showRepoSelectionDialog(${globalIndex})">pick git clone</span>`}<span class="copy-prompt" onclick="copyPrompt(${globalIndex})">copy prompt for debugging<div class="prompt-tooltip" id="prompt-tooltip-${globalIndex}"></div></span>
                    <div class="ai-log" id="ai-log-${globalIndex}" style="display:none"></div>
                </td>`;
  }

  function prRow(pr, includeAuthor, globalIndex, includeState) {
    const repoShort = pr.repo.split('/').pop();
    const authorSpan = includeAuthor ? ` <span class="author">@${escapeHtml(pr.author)}</span>` : '';
    const stateSpan = includeState ? stateBadge(pr.state) : '';
    const color = repoColor(repoShort);
    return `            <tr>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col"><a href="${escapeHtml(pr.html_url)}">#${pr.number} ${escapeHtml(pr.title)}</a>${authorSpan}${stateSpan}</td>
                <td class="branch-col status-loading" id="branch-${globalIndex}">waiting...</td>
                ${statusCell(pr, globalIndex)}
                <td class="ci-col status-loading" id="ci-${globalIndex}">waiting...</td>
                <td class="days-col days-${daysClass(pr.days)}">${pr.days}d</td>
            </tr>`;
  }

  function issueRow(issue, globalIndex) {
    const repoShort = issue.repo.split('/').pop();
    const color = repoColor(repoShort);
    return `            <tr>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col" colspan="2"><a href="${escapeHtml(issue.html_url)}">#${issue.number} ${escapeHtml(issue.title)}</a></td>
                ${statusCell(issue, globalIndex)}
                <td class="ci-col"></td>
                <td class="days-col days-${daysClass(issue.days)}">${issue.days}d</td>
            </tr>`;
  }

  let updateHtml = '';
  if (updateInfo) {
    const commitItems = updateInfo.commits.map(c => {
      const lines = c.split('\n');
      const title = lines[0];
      const body = lines.slice(1).join('\n').trim();
      return `<li><strong>${escapeHtml(title)}</strong>${body ? `<br><span style="color:#484f58;white-space:pre-wrap">${escapeHtml(body)}</span>` : ''}</li>`;
    }).join('');
    updateHtml = `<div class="update-overlay" id="update-overlay" onclick="document.getElementById('update-overlay').style.display='none';document.getElementById('update-popup').style.display='none'"></div>
    <div class="update-popup" id="update-popup">
        <span style="color:#d29922;font-size:14px;font-weight:600">Update available</span>
        <p style="color:#8b949e;margin:8px 0">${updateInfo.behind} new commit${updateInfo.behind > 1 ? 's' : ''}:</p>
        <ul style="margin:4px 0 12px 20px;padding:0;color:#8b949e">${commitItems}</ul>
        <span style="color:#c9d1d9">Run:</span>
        <code>cd ~/github-status && ./update.sh</code>
    </div>`;
  }

  function correspondenceStatusCell(item, globalIndex) {
    if (item.fetchError) {
      return `<td class="status-col status-bad">Fetch failed: ${escapeHtml(item.fetchError)}</td>`;
    }
    const urlEsc = escapeHtml(item.html_url).replace(/'/g, '&#39;');
    return `<td class="status-col" id="status-${globalIndex}">
                    <span class="status-text">waiting...</span>
                    <div class="correspondence-citations" id="corr-${globalIndex}"></div>
                    <br><span id="inline-actions-${globalIndex}"></span><span class="action-btn action-btn-archive" onclick="archiveItem('${urlEsc}', this)">ARCHIVE<span class="archive-tooltip">YOU WILL NOT SEE UPDATES FOR THIS PR!!!</span></span><span class="copy-prompt" onclick="copyPrompt(${globalIndex})">copy prompt for debugging<div class="prompt-tooltip" id="prompt-tooltip-${globalIndex}"></div></span>
                    <div class="ai-log" id="ai-log-${globalIndex}" style="display:none"></div>
                </td>`;
  }

  function correspondenceRow(item, includeAuthor, globalIndex, includeState) {
    const repoShort = item.repo.split('/').pop();
    const authorSpan = includeAuthor ? ` <span class="author">@${escapeHtml(item.author)}</span>` : '';
    const stateSpan = includeState ? stateBadge(item.state) : '';
    const color = repoColor(repoShort);
    const isArchived = archivedSet.has(item.html_url);
    const urlAttr = escapeHtml(item.html_url).replace(/"/g, '&quot;');
    return `            <tr data-url="${urlAttr}"${isArchived ? ' data-archived="1" style="display:none"' : ''}>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col" colspan="2"><a href="${escapeHtml(item.html_url)}">#${item.number} ${escapeHtml(item.title)}</a>${authorSpan}${stateSpan}</td>
                ${correspondenceStatusCell(item, globalIndex)}
                <td class="ci-col"></td>
                <td class="days-col days-${daysClass(item.days)}">${item.days}d</td>
            </tr>`;
  }

  const periodLabels = { '7d': '7 days', '30d': '30 days', '90d': '3 months', 'all': 'All time' };
  const periodOptions = ['7d', '30d', '90d', 'all'].map(v =>
    `<option value="${v}"${v === period ? ' selected' : ''}>${periodLabels[v]}</option>`
  ).join('');

  let idx = 0;
  const myRows = myPRs.map(pr => prRow(pr, false, idx++, false)).join('\n');
  const reviewRows = reviewPRs.map(pr => prRow(pr, true, idx++, false)).join('\n');
  const assignedIssueRows = assignedIssues.map(i => issueRow(i, idx++)).join('\n');
  const createdIssueRows = createdIssues.map(i => issueRow(i, idx++)).join('\n');
  const mentionedPRRows = mentionedPRs.map(pr => correspondenceRow(pr, true, idx++, true)).join('\n');
  const commentedPRRows = commentedPRs.map(pr => correspondenceRow(pr, true, idx++, true)).join('\n');
  const mentionedIssueRows = mentionedIssues.map(i => correspondenceRow(i, false, idx++, false)).join('\n');
  const commentedIssueRows = commentedIssues.map(i => correspondenceRow(i, false, idx++, false)).join('\n');

  const visibleMentionedPRs = mentionedPRs.filter(p => !archivedSet.has(p.html_url)).length;
  const visibleCommentedPRs = commentedPRs.filter(p => !archivedSet.has(p.html_url)).length;
  const visibleMentionedIssues = mentionedIssues.filter(i => !archivedSet.has(i.html_url)).length;
  const visibleCommentedIssues = commentedIssues.filter(i => !archivedSet.has(i.html_url)).length;

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
        h1 { font-size: 22px; margin: 0 0 16px 0; color: #58a6ff; }
        h1.section-heading { font-size: 28px; margin: 36px 0 12px 0; color: #58a6ff; border-bottom: 2px solid #58a6ff; padding-bottom: 10px; text-transform: uppercase; }
        h2 { font-size: 18px; margin: 24px 0 8px 0; color: #58a6ff; cursor: pointer; user-select: none; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 0; table-layout: fixed; }
        hr.subdivider { border: none; border-top: 1px solid #58a6ff; margin: 4px 0 20px 0; }
        h2::before { content: '▼ '; font-size: 11px; }
        h2.folded::before { content: '▶ '; font-size: 11px; }
        h2.folded + table { display: none; }
        .fold-controls { margin: 8px 0; font-size: 11px; }
        .fold-controls a { color: #58a6ff; cursor: pointer; margin-right: 12px; }
        th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #21262d; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
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
        .ci-col { font-size: 11px; vertical-align: top; }
        .ci-link { color: #f85149; font-size: 11px; }
        .repo-col { font-weight: 500; width: 5%; }
        .author { color: #8b949e; font-size: 11px; }
        .title-col { width: 18%; }
        .status-col { font-size: 11px; width: 37%; }
        .branch-col { font-size: 11px; width: 24%; }
        .branch-name { cursor: pointer; color: #8b949e; }
        .checkout-cmd { cursor: pointer; color: #484f58; font-size: 10px; position: relative; }
        .checkout-cmd:hover { color: #58a6ff; }
        .checkout-cmd.copied { color: #3fb950; }
        .checkout-cmd:hover::before { content: attr(data-cmd); position: absolute; left: 0; bottom: 100%; background: #2d1b1b; border: 1px solid #5c3030; border-radius: 4px; padding: 4px 8px; color: #c9d1d9; font-size: 11px; width: max-content; max-width: 500px; z-index: 10; margin-bottom: 4px; }
        .branch-name:hover { color: #58a6ff; }
        .copy-toast { position: absolute; bottom: 100%; left: 0; background: #1a3a1a; border: 1px solid #3fb950; border-radius: 4px; padding: 2px 8px; color: #3fb950; font-size: 11px; white-space: nowrap; z-index: 10; margin-bottom: 4px; pointer-events: none; }
        .branch-name.copied { color: #3fb950; }
        .ci-col { width: 8%; }
        .days-col { text-align: right; width: 4%; }
        .footer { color: #484f58; font-size: 11px; margin-top: 20px; }
        .header-links { font-size: 11px; font-weight: 400; color: #484f58; margin-left: 12px; }
        .header-links a { color: #484f58; text-decoration: none; }
        .header-links a:hover { color: #58a6ff; }

        .state-badge { font-size: 10px; border: 1px solid; border-radius: 3px; padding: 1px 4px; margin-left: 4px; }
        .status-text { white-space: pre-wrap; }
        .status-text.loading { color: #d29922; }
        .copy-prompt { cursor: pointer; color: #8b949e; font-size: 10px; position: relative; padding: 2px 8px; margin-right: 6px; font-family: inherit; display: inline-block; }
        .copy-prompt:hover { color: #c9d1d9; border-color: #8b949e; }
        .action-btn { cursor: pointer; color: #8b949e; font-size: 10px; margin-right: 6px; background: #21262d; border: 1px solid #30363d; border-radius: 3px; padding: 2px 8px; font-family: inherit; display: inline-block; }
        .action-btn:hover { color: #c9d1d9; border-color: #8b949e; }
        .action-btn-accent { color: #58a6ff; border-color: #58a6ff; }
        .action-btn-accent:hover { color: #79c0ff; border-color: #79c0ff; background: #1a2233; }
        .inline-action { cursor: pointer; color: #3fb950; font-size: 10px; margin-right: 6px; background: #1a2b1a; border: 1px solid #3fb950; border-radius: 3px; padding: 2px 8px; font-family: inherit; display: inline-block; }
        .inline-action:hover { color: #56d364; border-color: #56d364; background: #223d22; }
        .clone-badge { font-size: 10px; color: #3fb950; padding: 1px 5px; margin-right: 6px; display: inline-block; }
        .prompt-tooltip { display: none; position: absolute; left: 0; top: 100%; background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 6px 8px; color: #8b949e; font-size: 11px; white-space: pre-wrap; width: max-content; max-width: 600px; max-height: 80vh; overflow-y: auto; z-index: 10; margin-top: 4px; }
        .copy-prompt:hover .prompt-tooltip { display: block; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .status-text.loading { animation: pulse 1.5s ease-in-out infinite; }

        @media (max-width: 900px) {
            table { table-layout: auto; }
            thead { display: none; }
            tr { display: flex; flex-wrap: wrap; border-bottom: 1px solid #21262d; padding: 6px 0; }
            td { border-bottom: none; }
            .repo-col { width: auto; }
            .title-col { width: 100%; order: 1; }
            .branch-col { width: 100%; order: 2; }
            .status-col { width: 100%; order: 3; }
            .ci-col { width: auto; order: 4; }
            .days-col { width: auto; order: 5; margin-left: auto; }
        }
        .update-btn { background: none; border: 1px solid #d29922; color: #d29922; padding: 2px 8px; border-radius: 3px; font-family: inherit; font-size: 11px; cursor: pointer; margin-left: 12px; }
        .update-btn:hover { background: #d29922; color: #0d1117; }
        .update-popup { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; z-index: 200; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; font-size: 12px; }
        .update-popup code { background: #21262d; padding: 2px 6px; border-radius: 3px; color: #c9d1d9; display: block; margin-top: 8px; }
        .update-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 199; }
        .period-select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 3px; padding: 2px 6px; font-family: inherit; font-size: 12px; margin-left: 8px; cursor: pointer; }
        .period-select:hover { border-color: #58a6ff; }
        .nav-tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid #21262d; }
        .nav-tab { color: #8b949e; text-decoration: none; padding: 8px 16px; font-size: 13px; border-bottom: 2px solid transparent; cursor: pointer; }
        .nav-tab:hover { color: #c9d1d9; }
        .nav-tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .correspondence-citations { margin-top: 4px; font-size: 11px; }
        .correspondence-citations .corr-entry { margin-bottom: 4px; line-height: 1.5; }
        .correspondence-citations .corr-author { color: #d29922; font-weight: 500; }
        .correspondence-citations a { color: #8b949e; text-decoration: underline; }
        .correspondence-citations a:hover { color: #c9d1d9; }
        .action-btn-archive { color: #f85149; border-color: #f85149; position: relative; }
        .action-btn-archive:hover { color: #ff7b72; border-color: #ff7b72; background: #2d1b1b; }
        .archive-tooltip { display: none; position: absolute; left: 0; bottom: 100%; background: #161b22; border: 1px solid #f85149; border-radius: 4px; padding: 4px 8px; color: #f85149; font-weight: 700; font-size: 11px; white-space: nowrap; z-index: 10; margin-bottom: 4px; pointer-events: none; }
        .action-btn-archive:hover .archive-tooltip { display: block; }
        #archive-info { color: #8b949e; font-size: 11px; margin: 4px 0 12px 0; }
        #archive-info a { color: #58a6ff; cursor: pointer; }
        #archive-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 199; }
        #archive-popup { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; z-index: 200; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; font-size: 12px; }
        #archive-popup .archive-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #21262d; }
        #archive-popup .archive-item a { color: #58a6ff; word-break: break-all; }
        #archive-popup .unarchive-btn { cursor: pointer; color: #3fb950; background: #1a2b1a; border: 1px solid #3fb950; border-radius: 3px; padding: 2px 8px; font-family: inherit; font-size: 11px; margin-left: 8px; white-space: nowrap; }
        #archive-popup .unarchive-btn:hover { color: #56d364; border-color: #56d364; background: #223d22; }
    </style>
</head>
<body>
    <script>(function(){var o=console.error;function banner(){if(document.body&&!document.getElementById('_err')){var d=document.createElement('div');d.id='_err';d.style.cssText='background:#3d1f1f;color:#f85149;padding:6px 12px;font-size:12px;font-family:monospace;position:sticky;top:0;z-index:999;border-bottom:1px solid #f85149';d.textContent='There are errors in dev console';document.body.prepend(d)}}console.error=function(){o.apply(console,arguments);banner();setTimeout(banner,0)};window.onerror=function(m,s,l,c,e){o.call(console,e||m);banner();setTimeout(banner,0)};window.addEventListener('unhandledrejection',function(e){console.error(e.reason)})})()</script>
    ${updateHtml}
    <h1>GitHub Status - ${date}${updateInfo ? ' <button class="update-btn" onclick="document.getElementById(\'update-overlay\').style.display=\'block\';document.getElementById(\'update-popup\').style.display=\'block\'">UPDATE AVAILABLE</button>' : ''} <span class="header-links"><a href="https://github.com/Romex91/github-status/issues/new?template=bug_report.md" target="_blank">file an issue</a> · <a href="https://github.com/Romex91/github-status/issues/new?template=feature_request.md" target="_blank">request a feature</a></span></h1>
    <div class="nav-tabs">
        <span class="nav-tab active" data-tab="prs" onclick="switchTab('prs')">Pull Requests</span>
        <span class="nav-tab" data-tab="issues" onclick="switchTab('issues')">Issues</span>
        <span class="nav-tab" data-tab="correspondence" onclick="switchTab('correspondence')">Correspondence</span>
    </div>
    <div class="fold-controls"><a onclick="foldAll()">Fold all</a><a onclick="unfoldAll()">Unfold all</a></div>

    <div id="tab-prs" class="tab-panel active">
    <h1 class="section-heading">Pull Requests</h1>

    <h2 onclick="toggleFold(this)">My Open PRs (${myPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col">Branch</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col">CI</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${myRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="toggleFold(this)">PRs Waiting for My Review (${reviewPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col">Branch</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col">CI</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${reviewRows}
        </tbody>
    </table>
    <hr class="subdivider">
    </div>

    <div id="tab-issues" class="tab-panel">
    <h1 class="section-heading">Issues</h1>

    <h2 onclick="toggleFold(this)">Issues Assigned to Me (${assignedIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col"></th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${assignedIssueRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="toggleFold(this)">Issues I Created (${createdIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col"></th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${createdIssueRows}
        </tbody>
    </table>
    <hr class="subdivider">
    </div>

    <div id="tab-correspondence" class="tab-panel">
    <h1 class="section-heading">Correspondence <select class="period-select" onchange="fetch('/api/period',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({period:this.value})}).then(function(){location.reload()})">${periodOptions}</select></h1>
    <div id="archive-info" style="display:${archivedSet.size > 0 ? '' : 'none'}">
        <span id="archive-count">${archivedSet.size}</span> archived — <a onclick="showArchived()">manage</a>
    </div>

    <h2 onclick="toggleFold(this)">@${escapeHtml(ghUsername)} mentioned in PRs (${visibleMentionedPRs})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col" colspan="2">Title</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${mentionedPRRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="toggleFold(this)">My comments in PRs of other people (${visibleCommentedPRs})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col" colspan="2">Title</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${commentedPRRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="toggleFold(this)">@${escapeHtml(ghUsername)} mentioned in Issues (${visibleMentionedIssues})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col" colspan="2">Title</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${mentionedIssueRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="toggleFold(this)">My comments in Issues of other people (${visibleCommentedIssues})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col" colspan="2">Title</th>
                <th class="status-col">AI-Status</th>
                <th class="ci-col"></th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${commentedIssueRows}
        </tbody>
    </table>
    <hr class="subdivider">
    </div>

    <p class="footer">Generated ${date}</p>

    <script>
        var _activeTab = localStorage.getItem('activeTab') || 'prs';

        function switchTab(tab) {
            // Save scroll position for current tab
            sessionStorage.setItem('scrollY-' + _activeTab, window.scrollY);
            _activeTab = tab;
            localStorage.setItem('activeTab', tab);
            document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
            document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
            document.getElementById('tab-' + tab).classList.add('active');
            document.querySelector('.nav-tab[data-tab="'+tab+'"]').classList.add('active');
            // Restore scroll position for new tab
            window.scrollTo(0, parseInt(sessionStorage.getItem('scrollY-' + tab)) || 0);
        }

        function saveFoldState() {
            document.querySelectorAll('.tab-panel').forEach(function(panel) {
                var tab = panel.id.replace('tab-', '');
                var state = [];
                panel.querySelectorAll('h2').forEach(function(h) { state.push(h.classList.contains('folded')); });
                localStorage.setItem('foldState-' + tab, JSON.stringify(state));
            });
        }
        function restoreFoldState() {
            document.querySelectorAll('.tab-panel').forEach(function(panel) {
                var tab = panel.id.replace('tab-', '');
                var raw = localStorage.getItem('foldState-' + tab);
                if (!raw) return;
                var state = JSON.parse(raw);
                panel.querySelectorAll('h2').forEach(function(h, i) {
                    if (state[i]) h.classList.add('folded');
                });
            });
        }
        function toggleFold(el) {
            el.classList.toggle('folded');
            saveFoldState();
        }
        function foldAll() {
            var panel = document.getElementById('tab-' + _activeTab);
            panel.querySelectorAll('h2').forEach(function(h) { h.classList.add('folded'); });
            saveFoldState();
        }
        function unfoldAll() {
            var panel = document.getElementById('tab-' + _activeTab);
            panel.querySelectorAll('h2').forEach(function(h) { h.classList.remove('folded'); });
            saveFoldState();
        }
        restoreFoldState();
        switchTab(_activeTab);
        window.addEventListener('beforeunload', function() {
            sessionStorage.setItem('scrollY-' + _activeTab, window.scrollY);
        });

        var _clonePaths = {};
        function inlineChat(index) {
            fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: index, action: 'chat-here', clonePath: _clonePaths[index] || '' })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.error) throw new Error(d.error);
                var el = document.getElementById('inline-actions-' + index);
                if (el) showCopyToast(el, 'opened terminal window');
            });
        }
        function inlineIDE(cmd, index) {
            fetch('/api/open-ide', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd: cmd, clonePath: _clonePaths[index] || '' })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.error) throw new Error(d.error);
            });
        }

        function copyPrompt(index) {
            var log = document.getElementById('ai-log-' + index);
            var text = log.textContent || '';
            if (!text) return;
            var btn = log.parentNode.querySelector('.copy-prompt');
            navigator.clipboard.writeText(text).then(function() { showCopyToast(btn); });
        }

        function copyCmd(el) {
            var cmd = el.getAttribute('data-cmd');
            if (!cmd) return;
            navigator.clipboard.writeText(cmd).then(function() {
                showCopyToast(el);
                el.classList.add('copied');
                setTimeout(function() {
                    el.classList.remove('copied');
                }, 1000);
            });
        }

        function showCopyToast(el, msg) {
            var wrapper = el.closest('td') || el.parentNode;
            wrapper.style.position = 'relative';
            var toast = document.createElement('span');
            toast.className = 'copy-toast';
            toast.textContent = msg || 'copied!';
            wrapper.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 1500);
        }

        function copyBranch(el) {
            var text = el.textContent;
            if (!text) return;
            navigator.clipboard.writeText(text).then(function() { showCopyToast(el); });
        }

        function updateHeadingCount(row, delta) {
            var section = row.closest('table').previousElementSibling;
            while (section && section.tagName !== 'H2') section = section.previousElementSibling;
            if (!section) return;
            var m = section.textContent.match(/\\((\d+)\\)/);
            if (m) {
                var newCount = Math.max(0, parseInt(m[1]) + delta);
                section.childNodes.forEach(function(n) {
                    if (n.nodeType === 3) n.textContent = n.textContent.replace(/\\(\d+\\)/, '(' + newCount + ')');
                });
            }
        }

        function updateArchiveInfo(delta) {
            var countEl = document.getElementById('archive-count');
            var infoEl = document.getElementById('archive-info');
            var n = Math.max(0, parseInt(countEl.textContent) + delta);
            countEl.textContent = n;
            infoEl.style.display = n > 0 ? '' : 'none';
        }

        function archiveItem(url, el) {
            var row = el.closest('tr');
            var link = row.querySelector('.title-col a');
            var title = link ? link.textContent : url;
            row.setAttribute('data-archived', '1');
            row.style.display = 'none';
            updateHeadingCount(row, -1);
            updateArchiveInfo(1);
            fetch('/api/correspondence-archive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url, action: 'archive', title: title })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.error) throw new Error(d.error);
            });
        }

        function showArchived() {
            fetch('/api/correspondence-archive').then(function(r) { return r.json(); }).then(function(d) {
                if (d.error) throw new Error(d.error);
                var existing = document.getElementById('archive-overlay');
                if (existing) existing.remove();
                var existingPopup = document.getElementById('archive-popup');
                if (existingPopup) existingPopup.remove();

                var overlay = document.createElement('div');
                overlay.id = 'archive-overlay';
                var popup = document.createElement('div');
                popup.id = 'archive-popup';
                overlay.onclick = function() { overlay.remove(); popup.remove(); };

                var urls = Object.keys(d.archived);
                var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="color:#c9d1d9;font-size:14px;font-weight:600">Archived items (' + urls.length + ')</span><span style="cursor:pointer;color:#8b949e;font-size:18px" onclick="document.getElementById(\\'archive-overlay\\').remove();document.getElementById(\\'archive-popup\\').remove()">\u00d7</span></div>';
                if (urls.length === 0) {
                    html += '<div style="color:#8b949e">No archived items.</div>';
                } else {
                    urls.forEach(function(url) {
                        var title = d.archived[url] || url;
                        var u = url.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                        html += '<div class="archive-item"><a href="' + u + '" target="_blank">' + title.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a><button class="unarchive-btn" onclick="unarchiveItem(\\'' + u.replace(/'/g,'&#39;') + '\\')">unarchive</button></div>';
                    });
                }
                popup.innerHTML = html;
                document.body.appendChild(overlay);
                document.body.appendChild(popup);
            });
        }

        function unarchiveItem(url) {
            // Close overlay first
            var ov = document.getElementById('archive-overlay');
            var pp = document.getElementById('archive-popup');
            if (ov) ov.remove();
            if (pp) pp.remove();

            fetch('/api/correspondence-archive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url, action: 'unarchive' })
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.error) throw new Error(d.error);
                // Show DOM row if it exists (same time period)
                var rows = document.querySelectorAll('#tab-correspondence tr[data-url="' + url.replace(/"/g, '\\\\"') + '"]');
                rows.forEach(function(row) {
                    row.removeAttribute('data-archived');
                    row.style.display = '';
                    updateHeadingCount(row, 1);
                    var idx = parseInt(row.getAttribute('data-idx'));
                    if (!isNaN(idx) && !enqueued[idx]) {
                        enqueued[idx] = true;
                        pendingEnqueue.push(idx);
                        if (!enqueueTimer) enqueueTimer = setTimeout(flushEnqueue, 50);
                    }
                });
                updateArchiveInfo(-1);
                // Re-open overlay if more items remain
                if (d.archivedCount > 0) showArchived();
            });
        }

        // Connect to AI status stream
        var es = new EventSource('/api/ai-stream');
        var phaseTimers = {};

        function onSSE(source, event, handler) {
            source.addEventListener(event, function(e) {
                var d = JSON.parse(e.data);
                if (d.error) { console.error(d.error); return; }
                handler(d);
            });
        }

        var pendingScanQueue = [];
        var scanRunning = false;
        function drainScanQueue() {
            if (scanRunning || !pendingScanQueue.length) return;
            scanRunning = true;
            var idx = pendingScanQueue.shift();
            fetch('/api/repo-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: idx })
            }).then(function(r) { return r.json(); }).then(function(scan) {
                if (scan.error) throw new Error(scan.error);
                var match = null;
                for (var j = 0; j < (scan.clones || []).length; j++) {
                    var c = scan.clones[j];
                    if (c.onPRBranch && !c.behindOrigin) { match = c.path; break; }
                }
                if (!match) return;
                _clonePaths[idx] = match;
                var inlineEl = document.getElementById('inline-actions-' + idx);
                if (!inlineEl) return;
                var parts = match.split('/');
                var homePath = (parts[1] === 'home' || parts[1] === 'Users') ? '~/' + parts.slice(3).join('/') : match;
                var h = '<span class="clone-badge">' + homePath + '</span>';
                h += '<span class="inline-action" onclick="inlineChat(' + idx + ')">chat</span>';
                var ides = (typeof INSTALLED_IDES !== 'undefined') ? INSTALLED_IDES : [];
                for (var k = 0; k < ides.length; k++) {
                    var cmd = ides[k].cmd.replaceAll('&','&amp;').replaceAll('"','&quot;');
                    h += '<span class="inline-action" onclick="inlineIDE(&quot;' + cmd + '&quot;,' + idx + ')">' + ides[k].name.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
                }
                inlineEl.innerHTML = h;
            }).finally(function() {
                scanRunning = false;
                drainScanQueue();
            });
        }

        onSSE(es, 'ai-phase', function(d) {
            var cell = document.getElementById('status-' + d.index);
            if (!cell) return;
            var statusSpan = cell.querySelector('.status-text');
            if (!statusSpan) return;
            var branchCell = document.getElementById('branch-' + d.index);
            var startTime = Date.now();
            if (phaseTimers[d.index]) clearInterval(phaseTimers[d.index]);
            function update() {
                var elapsed = Math.floor((Date.now() - startTime) / 1000);
                statusSpan.textContent = 'Running "' + d.phase + '" for ' + elapsed + 's';
                if (branchCell && branchCell.classList.contains('status-loading')) {
                    branchCell.textContent = 'Running "' + d.phase + '" for ' + elapsed + 's';
                }
            }
            update();
            phaseTimers[d.index] = setInterval(update, 1000);
        });

        onSSE(es, 'pr-details', function(d) {
            var branchCell = document.getElementById('branch-' + d.index);
            if (branchCell) {
                branchCell.classList.remove('status-loading');
                var branch = d.branch;
                var html = '<span class="branch-name" onclick="copyBranch(this)" title="Click to copy">' + branch.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
                if (branch) {
                    var cmd = 'cd ~/' + d.repoShort + ' && git fetch origin ' + branch + ' && git checkout ' + branch;
                    html += '<br><span class="checkout-cmd" onclick="copyCmd(this)" data-cmd="' + cmd.replaceAll('"','&quot;') + '">copy git checkout cmd</span>';
                }
                branchCell.innerHTML = html;
            }
            var ciCell = document.getElementById('ci-' + d.index);
            if (ciCell) {
                ciCell.classList.remove('status-loading');
                if (d.failing && d.failing.length) {
                    ciCell.innerHTML = d.failing.map(function(c) {
                        var name = (c.name || c.context || 'ci').replace(/^ci\\/circleci:\\s*/i, '').replaceAll('&','&amp;').replaceAll('<','&lt;');
                        var url = c.detailsUrl || c.targetUrl || '';
                        return url ? '<a class="ci-link" href="' + url.replaceAll('"','&quot;') + '">' + name + '</a>' : '<span class="ci-link">' + name + '</span>';
                    }).join('<br>');
                } else {
                    ciCell.textContent = '';
                }
            }
            pendingScanQueue.push(d.index); drainScanQueue();
        });

        onSSE(es, 'ai-log', function(d) {
            var log = document.getElementById('ai-log-' + d.index);
            log.textContent += d.text;
            var btn = log.parentNode.querySelector('.copy-prompt');
            var tooltip = document.getElementById('prompt-tooltip-' + d.index);
            if (tooltip) tooltip.textContent = log.textContent;
        });

        onSSE(es, 'ai-done', function(d) {
            if (phaseTimers[d.index]) { clearInterval(phaseTimers[d.index]); delete phaseTimers[d.index]; }
            var cell = document.getElementById('status-' + d.index);
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\\\n--- Result ---\\\\n' + JSON.stringify({statusText: d.statusText, statusClass: d.statusClass, correspondence: d.correspondence}, null, 2);
            var btn = cell.querySelector('.copy-prompt');
            if (btn) btn.setAttribute('data-preview', logDiv.textContent.slice(0, 500) + (logDiv.textContent.length > 500 ? '...' : ''));
            var statusSpan = cell.querySelector('.status-text');
            statusSpan.className = 'status-text';
            statusSpan.textContent = d.statusText;
            cell.className = 'status-col status-' + d.statusClass;
            // Render correspondence citations
            var corrDiv = document.getElementById('corr-' + d.index);
            if (corrDiv && d.correspondence && d.correspondence.length) {
                var html = '';
                for (var i = 0; i < d.correspondence.length; i++) {
                    var c = d.correspondence[i];
                    var author = (c.author || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    var text = (c.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    var textHtml = c.url ? '<a href="' + c.url + '" target="_blank">' + text + '</a>' : text;
                    html += '<div class="corr-entry"><span class="corr-author">@' + author + ':</span> ' + textHtml + '</div>';
                }
                corrDiv.innerHTML = html;
            }
        });

        onSSE(es, 'ai-error', function() {});

        es.onerror = function() {
            if (es.readyState === EventSource.CLOSED) return;
            es.close();
            console.error('AI stream connection lost');
        };

        document.querySelectorAll('.status-text').forEach(function(el) {
            el.classList.add('loading');
        });

        // Lazy-load: only request AI processing for items visible in the viewport
        var enqueued = {};
        var pendingEnqueue = [];
        var enqueueTimer = null;

        function flushEnqueue() {
            enqueueTimer = null;
            if (pendingEnqueue.length === 0) return;
            var indices = pendingEnqueue.slice();
            pendingEnqueue = [];
            fetch('/api/ai-enqueue', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({indices: indices})
            }).then(function(r) { if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'HTTP ' + r.status); }); });
        }

        var observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (!entry.isIntersecting) return;
                var idx = parseInt(entry.target.getAttribute('data-idx'));
                if (isNaN(idx) || enqueued[idx]) return;
                enqueued[idx] = true;
                pendingEnqueue.push(idx);
                observer.unobserve(entry.target);
            });
            if (pendingEnqueue.length > 0 && !enqueueTimer) {
                enqueueTimer = setTimeout(flushEnqueue, 50);
            }
        }, { rootMargin: '200%' });

        document.querySelectorAll('[id^="status-"]').forEach(function(cell) {
            var idx = parseInt(cell.id.replace('status-', ''));
            var row = cell.closest('tr');
            if (row) {
                row.setAttribute('data-idx', idx);
                observer.observe(row);
            }
        });
    </script>
    <script>var INSTALLED_IDES = ${JSON.stringify(installedIDEs)};</script>
    <script src="/public/repo-picker.js"></script>
</body>
</html>`;
}
