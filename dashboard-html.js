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
    <script>
        {
            const origError = console.error;
            const showBanner = () => { const banner = document.getElementById('_err'); if (banner) banner.style.display = ''; };
            console.error = (...args) => { origError.apply(console, args); showBanner(); setTimeout(showBanner, 0); };
            window.onerror = (msg, src, line, col, err) => { origError.call(console, err || msg); showBanner(); setTimeout(showBanner, 0); };
            window.addEventListener('unhandledrejection', event => console.error(event.reason));
        }
    </script>
    <h1>
        GitHub Status
        <span id="_err" style="display:none;font-size:14px;margin-left:12px;color:#f85149">
            There are errors in dev console!!!
        </span>
    </h1>
    <div id="logs"></div>
    <script>
    {
        const logsEl = document.getElementById('logs');
        const logsOnly = new URLSearchParams(window.location.search).has('logs');
        const sseUrl = logsOnly ? '/api/status?logs' : '/api/status';
        const eventSource = new EventSource(sseUrl);

        const addLog = (msg, type, t) => {
            const line = document.createElement('div');
            line.className = 'log-line log-' + type;
            line.textContent = '[' + t + 's] ' + msg;
            logsEl.appendChild(line);
            window.scrollTo(0, document.body.scrollHeight);
            console.log('[' + t + 's] ' + msg);
        };

        const onSSE = (source, eventName, handler) => {
            source.addEventListener(eventName, event => {
                const data = JSON.parse(event.data);
                if (data.error) { console.error(data.error); return; }
                handler(data);
            });
        };

        onSSE(eventSource, 'log', data => addLog(data.message, data.type, data.t || '0.0'));
        onSSE(eventSource, 'syscall', data => {
            const line = document.createElement('div');
            line.className = 'log-line';
            const statusColor = data.ok ? '#3fb950' : '#f85149';
            const prefix = '[' + data.t + 's] ';
            line.innerHTML = '<span style="color:#484f58">' + prefix + '</span>'
                + '<span style="color:' + statusColor + '">[' + (data.ok ? 'OK' : 'FAIL') + ' ' + data.dur + ']</span>'
                + (data.pwd ? ' <span style="color:#484f58">pwd=' + data.pwd + '</span>' : '')
                + ' <span style="color:#c9d1d9">' + data.cmd.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>'
                + (data.reason ? ' <span style="color:#6e7681">(' + data.reason.replace(/&/g,'&amp;').replace(/</g,'&lt;') + ')</span>' : '');
            logsEl.appendChild(line);
            window.scrollTo(0, document.body.scrollHeight);
            console.log(prefix + '[' + (data.ok ? 'OK' : 'FAIL') + ' ' + data.dur + ']' + (data.pwd ? ' pwd=' + data.pwd : '') + ' ' + data.cmd + (data.reason ? ' (' + data.reason + ')' : ''));
        });
        onSSE(eventSource, 'done', data => {
            eventSource.close();
            console.log('RENDERING MAIN HTML');
            document.open();
            document.write(data.html);
            document.close();
            window.scrollTo(0, 0);
        });
        onSSE(eventSource, 'logs-done', () => {
            eventSource.close();
            addLog('--- logs-only mode: page render skipped ---', 'success');
        });
        onSSE(eventSource, 'fatal', () => {});

        eventSource.onerror = () => {
            if (eventSource.readyState === EventSource.CLOSED) return;
            eventSource.close();
            console.error('Status stream connection lost');
        };

        addLog('Connecting...', 'info');
    }
    </script>
</body>
</html>`;

export function buildDashboardHtml(myPRs, reviewPRs, assignedIssues, createdIssues, mentionedPRs, commentedPRs, mentionedIssues, commentedIssues, date, updateInfo, { repoColorMap, installedIDEs, period, ghUsername, archivedUrls, autoUnarchivedUrls, unimportantUrls, markedImportantUrls, checkoutItems }) {
  const archivedSet = new Set(Object.keys(archivedUrls || {}));
  const autoUnarchivedSet = new Set(autoUnarchivedUrls || []);
  const unimportantSet = new Set(Object.keys(unimportantUrls || {}));
  const markedImportantSet = new Set(markedImportantUrls || []);
  function repoColor(repoName) {
    return repoColorMap[repoName] || '#8b949e';
  }

  const chipPalette = {
    green:  { color: '#3fb950', bg: '#1a3a1a', border: '#238636' },
    yellow: { color: '#d29922', bg: '#3d1f00', border: '#9e6a03' },
    blue:   { color: '#58a6ff', bg: '#0c2d6b', border: '#1f6feb' },
    red:    { color: '#f85149', bg: '#3d0a0a', border: '#da3633' },
    purple: { color: '#a371f7', bg: '#271c4d', border: '#8957e5' },
    muted:  { color: '#484f58', bg: '#161b22', border: '#30363d' },
    grey:   { color: '#8b949e', bg: '#1c2128', border: '#30363d' },
  };

  const stateTones = { open: 'green', merged: 'purple', closed: 'red' };

  const divergeLabels = { ahead: ['ahead of remote', 'blue'], behind: ['behind remote', 'yellow'], diverged: ['diverged', 'red'], 'no-remote': ['no remote', 'muted'] };

  function chip(label, tone, extraClass) {
    const p = chipPalette[tone] || chipPalette.grey;
    return ` <span class="chip${extraClass ? ' ' + extraClass : ''}" style="color:${p.color};background:${p.bg};border-color:${p.border}">${label}</span>`;
  }

  function stateBadge(state) {
    if (!state) return '';
    return chip(state, stateTones[state] || 'grey');
  }

  function statusCell(item, globalIndex, prefillActions) {
    if (item.fetchError) {
      return `<td class="status-col status-bad">Fetch failed: ${escapeHtml(item.fetchError)}</td>`;
    }
    return `<td class="status-col" id="status-${globalIndex}">
                    <span class="status-text">queued...</span>
                    <br>
                    <span id="inline-actions-${globalIndex}">${prefillActions || ''}</span>
                    ${item.isIssue || item.section === 'checkout' ? '' : `<span class="action-btn action-btn-accent" onclick="showRepoSelectionDialog(${globalIndex})">checkout</span>`}
                    <span class="copy-prompt" onclick="copyPrompt(${globalIndex})">
                        copy prompt for debugging
                        <div class="prompt-tooltip" id="prompt-tooltip-${globalIndex}"></div>
                    </span>
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
                <td class="title-col" id="title-${globalIndex}">
                    <a href="${escapeHtml(pr.html_url)}">#${pr.number} ${escapeHtml(pr.title)}</a>
                    ${authorSpan}${stateSpan}
                </td>
                <td class="branch-col status-loading" id="branch-${globalIndex}">queued...</td>
                ${statusCell(pr, globalIndex)}
                <td class="ci-col status-loading" id="ci-${globalIndex}">queued...</td>
                <td class="days-col days-${daysClass(pr.days)}">${pr.days}d</td>
            </tr>`;
  }

  function issueRow(issue, globalIndex) {
    const repoShort = issue.repo.split('/').pop();
    const color = repoColor(repoShort);
    return `            <tr>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col" colspan="2">
                    <a href="${escapeHtml(issue.html_url)}">#${issue.number} ${escapeHtml(issue.title)}</a>
                </td>
                ${statusCell(issue, globalIndex)}
                <td class="ci-col"></td>
                <td class="days-col days-${daysClass(issue.days)}">${issue.days}d</td>
            </tr>`;
  }

  let updateHtml = '';
  if (updateInfo && updateInfo.behind) {
    const commitItems = updateInfo.commits.map(commit => {
      const lines = commit.split('\n');
      const title = lines[0];
      const body = lines.slice(1).join('\n').trim();
      return `<li>
            <strong>${escapeHtml(title)}</strong>
            ${body ? `<br><span style="color:#484f58;white-space:pre-wrap">${escapeHtml(body)}</span>` : ''}
        </li>`;
    }).join('');
    updateHtml = `<div class="update-overlay" id="update-overlay"
         onclick="document.getElementById('update-overlay').style.display='none';document.getElementById('update-popup').style.display='none'"></div>
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
                    <span class="status-text">queued...</span>
                    <div class="correspondence-citations" id="corr-${globalIndex}"></div>
                    <br>
                    <span id="inline-actions-${globalIndex}"></span>
                    <span class="action-btn action-btn-archive action-btn-disabled" id="archive-btn-${globalIndex}">ARCHIVE</span>
                    <span class="copy-prompt" onclick="copyPrompt(${globalIndex})">
                        copy prompt for debugging
                        <div class="prompt-tooltip" id="prompt-tooltip-${globalIndex}"></div>
                    </span>
                    <div class="ai-log" id="ai-log-${globalIndex}" style="display:none"></div>
                </td>`;
  }

  function correspondenceRow(item, includeAuthor, globalIndex, includeState) {
    const repoShort = item.repo.split('/').pop();
    const authorSpan = includeAuthor ? ` <span class="author">@${escapeHtml(item.author)}</span>` : '';
    const stateSpan = includeState ? stateBadge(item.state) : '';
    const color = repoColor(repoShort);
    const isArchived = archivedSet.has(item.html_url);
    const isUnimportant = !isArchived && unimportantSet.has(item.html_url);
    const urlAttr = escapeHtml(item.html_url).replace(/"/g, '&quot;');
    const isMarkedImportant = markedImportantSet.has(item.html_url);
    const unarchivedBadge = autoUnarchivedSet.has(item.html_url) ? chip('unarchived: new comments', 'yellow', 'unarchived-badge') : '';
    const importantBadge = isMarkedImportant ? chip('marked as important', 'blue', 'important-badge') : '';
    const hidden = isArchived || isUnimportant;
    const attrs = isArchived ? ' data-archived="1"' : isUnimportant ? ' data-unimportant="1"' : '';
    const miAttr = isMarkedImportant ? ' data-marked-important="1"' : '';
    return `            <tr data-url="${urlAttr}"${attrs}${miAttr}${hidden ? ' style="display:none"' : ''}>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col" colspan="2">
                    <a href="${escapeHtml(item.html_url)}">#${item.number} ${escapeHtml(item.title)}</a>
                    ${authorSpan}${stateSpan}${unarchivedBadge}${importantBadge}
                </td>
                ${correspondenceStatusCell(item, globalIndex)}
                <td class="ci-col"></td>
                <td class="days-col days-${daysClass(item.days)}">${item.days}d</td>
            </tr>`;
  }

  function checkoutActions(item, globalIndex) {
    let html = `<span class="inline-action" onclick="inlineChat(${globalIndex})">chat</span>`;
    for (const ide of installedIDEs) {
      const cmdEsc = escapeHtml(ide.cmd).replace(/'/g, '&#39;');
      html += `<span class="inline-action" onclick="inlineIDE('${cmdEsc}',${globalIndex})">${escapeHtml(ide.name)}</span>`;
    }
    return html;
  }

  function checkoutRow(item, globalIndex) {
    const repoShort = item.repo.split('/').pop();
    const color = repoColor(repoShort);
    const branchEsc = escapeHtml(item._checkoutBranch || '(detached)');
    const pathAttr = escapeHtml(item._checkoutPath).replace(/"/g, '&quot;');
    const skipAI = item._checkoutSkipAI;
    const actions = checkoutActions(item, globalIndex);
    return `            <tr data-path="${pathAttr}">
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col" id="title-${globalIndex}">
                    ${escapeHtml(item._checkoutDisplayPath)}
                </td>
                <td class="branch-col" id="branch-${globalIndex}"><span class="branch-name" onclick="copyBranch(this)" title="Click to copy">${branchEsc}</span></td>
                ${skipAI
                  ? `<td class="status-col" id="status-${globalIndex}" style="font-size:11px;color:#484f58">no PR<br><span id="inline-actions-${globalIndex}">${actions}</span></td>`
                  : statusCell(item, globalIndex, actions)}
                <td class="ci-col" id="ci-${globalIndex}"></td>
                <td class="days-col" id="days-${globalIndex}"></td>
            </tr>`;
  }

  const periodLabels = { '7d': '7 days', '30d': '30 days', '90d': '3 months', 'all': 'All time' };
  const periodOptions = ['7d', '30d', '90d', 'all'].map(value =>
    `<option value="${value}"${value === period ? ' selected' : ''}>${periodLabels[value]}</option>`
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
  const checkoutStartIdx = idx;
  const checkoutRows = (checkoutItems || []).map(item => checkoutRow(item, idx++)).join('\n');
  const checkoutCloneData = JSON.stringify((checkoutItems || []).map((item, i) => ({
    idx: checkoutStartIdx + i,
    path: item._checkoutPath,
    dirty: item._checkoutDirty,
    changedCount: item._checkoutChangedFiles,
    divergeStatus: item._checkoutDivergeStatus,
  })));

  const hiddenSet = new Set([...archivedSet, ...unimportantSet]);
  const visibleMentionedPRs = mentionedPRs.filter(pr => !hiddenSet.has(pr.html_url)).length;
  const visibleCommentedPRs = commentedPRs.filter(pr => !hiddenSet.has(pr.html_url)).length;
  const visibleMentionedIssues = mentionedIssues.filter(issue => !hiddenSet.has(issue.html_url)).length;
  const visibleCommentedIssues = commentedIssues.filter(issue => !hiddenSet.has(issue.html_url)).length;
  const totalCorrespondence = visibleMentionedPRs + visibleCommentedPRs + visibleMentionedIssues + visibleCommentedIssues;

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

        .chip { font-size: 10px; border: 1px solid; border-radius: 3px; padding: 1px 5px; margin-left: 6px; display: inline-block; }
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
        .push-btn { background: none; border: 1px solid #f85149; color: #f85149; padding: 2px 8px; border-radius: 3px; font-family: inherit; font-size: 11px; cursor: pointer; margin-left: 12px; }
        .push-btn:hover { background: #f85149; color: #0d1117; }
        .update-popup { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; z-index: 200; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; font-size: 12px; }
        .update-popup code { background: #21262d; padding: 2px 6px; border-radius: 3px; color: #c9d1d9; display: block; margin-top: 8px; }
        .update-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 199; }
        .period-select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 3px; padding: 2px 6px; font-family: inherit; font-size: 12px; margin-left: 8px; cursor: pointer; }
        .period-select:hover { border-color: #58a6ff; }
        .sticky-header { position: sticky; top: 0; z-index: 100; background: #0d1117; padding-bottom: 0; }
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
        .action-btn-archive.action-btn-disabled { color: #484f58; border-color: #484f58; cursor: default; pointer-events: none; }
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
    <script>
        {
            const origError = console.error;
            const showBanner = () => { const banner = document.getElementById('_err'); if (banner) banner.style.display = ''; };
            console.error = (...args) => { origError.apply(console, args); showBanner(); setTimeout(showBanner, 0); };
            window.onerror = (msg, src, line, col, err) => { origError.call(console, err || msg); showBanner(); setTimeout(showBanner, 0); };
            window.addEventListener('unhandledrejection', event => console.error(event.reason));
        }
    </script>
    ${updateHtml}
    <div class="sticky-header">
    <h1>
        GitHub Status - ${date}
        ${updateInfo && updateInfo.behind ? `<button class="update-btn" onclick="document.getElementById('update-overlay').style.display='block';document.getElementById('update-popup').style.display='block'">UPDATE AVAILABLE</button>` : ''}
        ${updateInfo && updateInfo.ahead ? `<button class="push-btn">${updateInfo.ahead} unpushed commit${updateInfo.ahead > 1 ? 's' : ''} — push!</button>` : ''}
        <span class="header-links">
            <a href="https://github.com/Romex91/github-status/issues/new?template=bug_report.md" target="_blank">file an issue</a>
            · <a href="https://github.com/Romex91/github-status/issues/new?template=feature_request.md" target="_blank">request a feature</a>
            <span id="_err" style="display:none">
                · <span style="color:#f85149;cursor:pointer" onclick="alert('Check the browser dev console for error details')" title="Check dev console for details">There are errors in dev console!!!</span>
            </span>
        </span>
    </h1>
    <div class="nav-tabs">
        <span class="nav-tab active" data-tab="prs" onclick="switchTab('prs')">Pull Requests</span>
        <span class="nav-tab" data-tab="issues" onclick="switchTab('issues')">Issues</span>
        <span class="nav-tab" data-tab="correspondence" onclick="switchTab('correspondence')">Correspondence (${totalCorrespondence})</span>
        <span class="nav-tab" data-tab="checkouts" onclick="switchTab('checkouts')">Checkouts (${(checkoutItems || []).length})</span>
    </div>
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
    <h1 class="section-heading">Correspondence
        <select class="period-select"
            onchange="fetch('/api/period',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({period:this.value})}).then(() => location.reload())">
            ${periodOptions}
        </select>
    </h1>
    <div id="archive-info" style="display:${archivedSet.size > 0 ? '' : 'none'}">
        <span id="archive-count">${archivedSet.size}</span> archived — <a onclick="showArchived()">manage</a>
    </div>
    <div id="unimportant-info" style="display:${unimportantSet.size > 0 ? '' : 'none'}">
        <span id="unimportant-count">${unimportantSet.size}</span> unimportant — <a onclick="showUnimportant()">manage</a>
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

    <h2 onclick="toggleFold(this)">@${escapeHtml(ghUsername)}'s comments in PRs (${visibleCommentedPRs})</h2>
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

    <h2 onclick="toggleFold(this)">@${escapeHtml(ghUsername)}'s comments in Issues (${visibleCommentedIssues})</h2>
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

    <div id="tab-checkouts" class="tab-panel">
    <h1 class="section-heading">Local Checkouts</h1>

    <h2 onclick="toggleFold(this)">Git Repositories (${(checkoutItems || []).length})</h2>
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
${checkoutRows}
        </tbody>
    </table>
    <hr class="subdivider">
    </div>

    <p class="footer">Generated ${date}</p>

    <script>
        let _activeTab = localStorage.getItem('activeTab') || 'prs';

        function switchTab(tab) {
            sessionStorage.setItem('scrollY-' + _activeTab, window.scrollY);
            _activeTab = tab;
            localStorage.setItem('activeTab', tab);
            document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
            document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
            document.getElementById('tab-' + tab).classList.add('active');
            document.querySelector('.nav-tab[data-tab="'+tab+'"]').classList.add('active');
            window.scrollTo(0, parseInt(sessionStorage.getItem('scrollY-' + tab)) || 0);
        }

        const saveFoldState = () => {
            document.querySelectorAll('.tab-panel').forEach(panel => {
                const tab = panel.id.replace('tab-', '');
                const state = [];
                panel.querySelectorAll('h2').forEach(heading => state.push(heading.classList.contains('folded')));
                localStorage.setItem('foldState-' + tab, JSON.stringify(state));
            });
        };
        const restoreFoldState = () => {
            document.querySelectorAll('.tab-panel').forEach(panel => {
                const tab = panel.id.replace('tab-', '');
                const raw = localStorage.getItem('foldState-' + tab);
                if (!raw) return;
                const state = JSON.parse(raw);
                panel.querySelectorAll('h2').forEach((heading, idx) => {
                    if (state[idx]) heading.classList.add('folded');
                });
            });
        };
        function toggleFold(el) {
            el.classList.toggle('folded');
            saveFoldState();
        }
        function foldAll() {
            const panel = document.getElementById('tab-' + _activeTab);
            panel.querySelectorAll('h2').forEach(heading => heading.classList.add('folded'));
            saveFoldState();
        }
        function unfoldAll() {
            const panel = document.getElementById('tab-' + _activeTab);
            panel.querySelectorAll('h2').forEach(heading => heading.classList.remove('folded'));
            saveFoldState();
        }
        restoreFoldState();
        switchTab(_activeTab);
        window.addEventListener('beforeunload', () => {
            sessionStorage.setItem('scrollY-' + _activeTab, window.scrollY);
        });

        const _clonePaths = {};
        const CHIP_PALETTE = ${JSON.stringify(chipPalette)};
        const STATE_TONES = ${JSON.stringify(stateTones)};
        const DIVERGE_LABELS = ${JSON.stringify(divergeLabels)};
        function makeChip(label, tone, extraClass) {
            const p = CHIP_PALETTE[tone] || CHIP_PALETTE.grey;
            return '<span class="chip' + (extraClass ? ' ' + extraClass : '') + '" style="color:' + p.color + ';background:' + p.bg + ';border-color:' + p.border + '">' + label + '</span>';
        }
        function inlineChat(index) {
            fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index, action: 'chat-here', clonePath: _clonePaths[index] || '' })
            }).then(resp => resp.json()).then(data => {
                if (data.error) throw new Error(data.error);
                const actionsEl = document.getElementById('inline-actions-' + index);
                if (actionsEl) showCopyToast(actionsEl, 'opened terminal window');
            });
        }
        function inlineIDE(cmd, index) {
            fetch('/api/open-ide', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd, clonePath: _clonePaths[index] || '' })
            }).then(resp => resp.json()).then(data => {
                if (data.error) throw new Error(data.error);
            });
        }

        function toHomePath(path) {
            const parts = path.split('/');
            return (parts[1] === 'home' || parts[1] === 'Users') ? '~/' + parts.slice(3).join('/') : path;
        }
        function renderCloneChips(clone, opts) {
            let html = '';
            const count = clone.changedFiles ? clone.changedFiles.length : (clone.changedCount || 0);
            if (clone.dirty) {
                const label = opts && opts.dirtyLabel ? opts.dirtyLabel(count) : (count + ' changed');
                html += makeChip(label, 'yellow');
            } else {
                html += makeChip('clean', 'green');
            }
            const dl = DIVERGE_LABELS[clone.divergeStatus];
            if (dl) html += makeChip(dl[0], dl[1]);
            return html;
        }
        for (const c of ${checkoutCloneData}) {
            _clonePaths[c.idx] = c.path;
            const bc = document.getElementById('branch-' + c.idx);
            if (bc) bc.innerHTML += renderCloneChips(c);
        }

        function copyPrompt(index) {
            const log = document.getElementById('ai-log-' + index);
            const text = log.textContent || '';
            if (!text) return;
            const btn = log.parentNode.querySelector('.copy-prompt');
            navigator.clipboard.writeText(text).then(() => showCopyToast(btn));
        }

        function copyCmd(el) {
            const cmd = el.getAttribute('data-cmd');
            if (!cmd) return;
            navigator.clipboard.writeText(cmd).then(() => {
                showCopyToast(el);
                el.classList.add('copied');
                setTimeout(() => el.classList.remove('copied'), 1000);
            });
        }

        function showCopyToast(el, msg) {
            const wrapper = el.closest('td') || el.parentNode;
            wrapper.style.position = 'relative';
            const toast = document.createElement('span');
            toast.className = 'copy-toast';
            toast.textContent = msg || 'copied!';
            wrapper.appendChild(toast);
            setTimeout(() => toast.remove(), 1500);
        }

        function copyBranch(el) {
            const text = el.textContent;
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => showCopyToast(el));
        }

        function updateHeadingCount(row, delta) {
            let heading = row.closest('table').previousElementSibling;
            while (heading && heading.tagName !== 'H2') heading = heading.previousElementSibling;
            if (!heading) return;
            const match = heading.textContent.match(/\\((\\d+)\\)/);
            if (match) {
                const newCount = Math.max(0, parseInt(match[1]) + delta);
                heading.childNodes.forEach(node => {
                    if (node.nodeType === 3) node.textContent = node.textContent.replace(/\\(\\d+\\)/, '(' + newCount + ')');
                });
            }
        }

        function updateCorrespondenceTab() {
            const tab = document.querySelector('span.nav-tab[data-tab="correspondence"]');
            if (!tab) return;
            const count = Array.from(document.querySelectorAll('#tab-correspondence tr[data-idx]')).filter(row => row.style.display !== 'none').length;
            tab.textContent = tab.textContent.replace(/\\((\\d+)\\)/, '(' + count + ')');
        }

        function updateInfoCount(prefix, delta) {
            const countEl = document.getElementById(prefix + '-count');
            const infoEl = document.getElementById(prefix + '-info');
            const newVal = Math.max(0, parseInt(countEl.textContent) + delta);
            countEl.textContent = newVal;
            infoEl.style.display = newVal > 0 ? '' : 'none';
            return newVal;
        }

        function showManagedPopup(opts) {
            fetch(opts.apiUrl).then(resp => resp.json()).then(data => {
                if (data.error) throw new Error(data.error);
                document.getElementById('archive-overlay')?.remove();
                document.getElementById('archive-popup')?.remove();

                const overlay = document.createElement('div');
                overlay.id = 'archive-overlay';
                const popup = document.createElement('div');
                popup.id = 'archive-popup';
                overlay.onclick = () => { overlay.remove(); popup.remove(); };

                const items = data[opts.dataKey];
                const urls = Object.keys(items);
                let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'
                    + '<span style="color:#c9d1d9;font-size:14px;font-weight:600">' + opts.title + ' (' + urls.length + ')</span>'
                    + '<span style="cursor:pointer;color:#8b949e;font-size:18px" onclick="document.getElementById(\\'archive-overlay\\').remove();document.getElementById(\\'archive-popup\\').remove()">\u00d7</span>'
                    + '</div>';
                if (urls.length === 0) {
                    html += '<div style="color:#8b949e">No items.</div>';
                } else {
                    urls.forEach(url => {
                        const entry = items[url];
                        const title = (entry && entry.title) ? entry.title : (typeof entry === 'string' ? entry : url);
                        const escaped = url.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                        html += '<div class="archive-item">'
                            + '<a href="' + escaped + '" target="_blank">' + title.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a>'
                            + '<button class="unarchive-btn" onclick="' + opts.actionFn + '(\\'' + escaped.replace(/'/g,'&#39;') + '\\')">' + opts.buttonLabel + '</button>'
                            + '</div>';
                    });
                }
                popup.innerHTML = html;
                document.body.appendChild(overlay);
                document.body.appendChild(popup);
            });
        }

        function restoreItem(url, opts) {
            document.getElementById('archive-overlay')?.remove();
            document.getElementById('archive-popup')?.remove();

            fetch(opts.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts.postBody(url))
            }).then(resp => resp.json()).then(data => {
                if (data.error) throw new Error(data.error);
                const rows = document.querySelectorAll('#tab-correspondence tr[data-url="' + url.replace(/"/g, '\\\\"') + '"]');
                rows.forEach(row => {
                    opts.attrs.forEach(attr => row.removeAttribute(attr));
                    row.style.display = '';
                    updateHeadingCount(row, 1);
                    if (opts.onRow) opts.onRow(row);
                    const rowIdx = parseInt(row.getAttribute('data-idx'));
                    if (!isNaN(rowIdx) && !enqueued[rowIdx]) {
                        enqueued[rowIdx] = true;
                        pendingEnqueue.push(rowIdx);
                        if (!enqueueTimer) enqueueTimer = setTimeout(flushEnqueue, 50);
                    }
                });
                updateInfoCount(opts.infoPrefix, -1);
                updateCorrespondenceTab();
                if (data[opts.remainingKey] > 0) opts.reopenFn();
            });
        }

        function showArchived() {
            showManagedPopup({ apiUrl: '/api/correspondence-archive', dataKey: 'archived', title: 'Archived items', actionFn: 'unarchiveItem', buttonLabel: 'unarchive' });
        }
        function showUnimportant() {
            showManagedPopup({ apiUrl: '/api/correspondence-unimportant', dataKey: 'items', title: 'Unimportant items', actionFn: 'markImportant', buttonLabel: 'important' });
        }

        function unarchiveItem(url) {
            restoreItem(url, {
                apiUrl: '/api/correspondence-archive',
                postBody: itemUrl => ({ url: itemUrl, action: 'unarchive' }),
                attrs: ['data-archived'],
                infoPrefix: 'archive',
                remainingKey: 'archivedCount',
                reopenFn: showArchived,
            });
        }

        function markImportant(url) {
            restoreItem(url, {
                apiUrl: '/api/correspondence-unimportant',
                postBody: itemUrl => ({ url: itemUrl, action: 'mark-important' }),
                attrs: ['data-unimportant'],
                infoPrefix: 'unimportant',
                remainingKey: 'unimportantCount',
                reopenFn: showUnimportant,
                onRow: row => {
                    row.setAttribute('data-marked-important', '1');
                    const titleCol = row.querySelector('.title-col');
                    if (titleCol && !titleCol.querySelector('.important-badge')) {
                        titleCol.insertAdjacentHTML('beforeend', makeChip('marked as important', 'blue', 'important-badge'));
                    }
                },
            });
        }

        function archiveItem(url, el) {
            const row = el.closest('tr');
            const link = row.querySelector('.title-col a');
            const title = link ? link.textContent : url;
            const lastCommentAt = row.getAttribute('data-last-comment') || null;
            row.querySelector('.unarchived-badge')?.remove();
            row.setAttribute('data-archived', '1');
            row.style.display = 'none';
            updateHeadingCount(row, -1);
            updateCorrespondenceTab();
            updateInfoCount('archive', 1);
            fetch('/api/correspondence-archive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, action: 'archive', title, lastCommentAt })
            }).then(resp => resp.json()).then(data => {
                if (data.error) throw new Error(data.error);
            });
        }



        // Connect to AI status stream
        const eventSource = new EventSource('/api/ai-stream');
        const phaseTimers = {};

        const onSSE = (source, eventName, handler) => {
            source.addEventListener(eventName, event => {
                const data = JSON.parse(event.data);
                if (data.error) { console.error(data.error); return; }
                handler(data);
            });
        };

        onSSE(eventSource, 'syscall', data => {
            console.log('[' + (data.ok ? 'OK' : 'FAIL') + ' ' + data.dur + ']' + (data.pwd ? ' pwd=' + data.pwd : '') + ' ' + data.cmd + (data.reason ? ' (' + data.reason + ')' : ''));
        });

        const pendingScanQueue = [];
        let scanRunning = false;
        function drainScanQueue() {
            if (scanRunning || !pendingScanQueue.length) return;
            scanRunning = true;
            const scanIdx = pendingScanQueue.shift();
            fetch('/api/repo-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: scanIdx })
            }).then(resp => resp.json()).then(scan => {
                if (scan.error) throw new Error(scan.error);
                if (_clonePaths[scanIdx]) return; // checkout item — already has clone info
                const match = (scan.clones || []).find(clone => clone.onPRBranch && clone.divergeStatus !== 'behind' && clone.divergeStatus !== 'diverged');
                if (!match) return;
                _clonePaths[scanIdx] = match.path;
                // Append clone path to title cell
                const titleCell = document.getElementById('title-' + scanIdx);
                if (titleCell) {
                    titleCell.innerHTML += '<br><span class="clone-badge">' + toHomePath(match.path) + '</span>';
                }
                // Append dirty/diverge chips to branch cell
                const branchCell = document.getElementById('branch-' + scanIdx);
                if (branchCell) {
                    branchCell.innerHTML += renderCloneChips(match);
                }
                // Add chat/IDE buttons to inline actions
                const inlineEl = document.getElementById('inline-actions-' + scanIdx);
                if (!inlineEl) return;
                let html = '<span class="inline-action" onclick="inlineChat(' + scanIdx + ')">chat</span>';
                const ides = (typeof INSTALLED_IDES !== 'undefined') ? INSTALLED_IDES : [];
                for (const ide of ides) {
                    const cmd = ide.cmd.replaceAll('&','&amp;').replaceAll('"','&quot;');
                    html += '<span class="inline-action" onclick="inlineIDE(&quot;' + cmd + '&quot;,' + scanIdx + ')">' + ide.name.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
                }
                inlineEl.innerHTML = html;
            }).finally(() => {
                scanRunning = false;
                drainScanQueue();
            });
        }

        onSSE(eventSource, 'ai-phase', data => {
            const cell = document.getElementById('status-' + data.index);
            if (!cell) return;
            const statusSpan = cell.querySelector('.status-text');
            if (!statusSpan) return;
            const branchCell = document.getElementById('branch-' + data.index);
            const startTime = Date.now();
            if (phaseTimers[data.index]) clearInterval(phaseTimers[data.index]);
            const update = () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                statusSpan.textContent = 'Running "' + data.phase + '" for ' + elapsed + 's';
                if (branchCell && branchCell.classList.contains('status-loading')) {
                    branchCell.textContent = 'Running "' + data.phase + '" for ' + elapsed + 's';
                }
            };
            update();
            phaseTimers[data.index] = setInterval(update, 1000);
        });

        onSSE(eventSource, 'pr-details', data => {
            const branchCell = document.getElementById('branch-' + data.index);
            if (branchCell) {
                branchCell.classList.remove('status-loading');
                const branch = data.branch;
                branchCell.innerHTML = '<span class="branch-name" onclick="copyBranch(this)" title="Click to copy">' + branch.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
            }
            const ciCell = document.getElementById('ci-' + data.index);
            if (ciCell) {
                ciCell.classList.remove('status-loading');
                if (data.failing && data.failing.length) {
                    ciCell.innerHTML = data.failing.map(check => {
                        const name = (check.name || check.context || 'ci').replace(/^ci\\/circleci:\\s*/i, '').replaceAll('&','&amp;').replaceAll('<','&lt;');
                        const url = check.detailsUrl || check.targetUrl || '';
                        return url ? '<a class="ci-link" href="' + url.replaceAll('"','&quot;') + '">' + name + '</a>' : '<span class="ci-link">' + name + '</span>';
                    }).join('<br>');
                } else {
                    ciCell.textContent = '';
                }
            }
            pendingScanQueue.push(data.index); drainScanQueue();
            // Checkout items: prepend PR link to title, update chips with refined diverge status
            if (data.prTitle) {
                const titleCell = document.getElementById('title-' + data.index);
                if (titleCell) {
                    const prLink = '<a href="' + data.prUrl + '">#' + data.prNumber + ' ' + data.prTitle.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a>'
                        + (data.prState ? makeChip(data.prState, STATE_TONES[data.prState] || 'grey') : '');
                    titleCell.innerHTML = prLink + '<br>' + titleCell.innerHTML;
                }
                const daysCell = document.getElementById('days-' + data.index);
                if (daysCell && data.prDays !== undefined) {
                    daysCell.textContent = data.prDays + 'd';
                    daysCell.className = 'days-col days-' + (data.prDays <= 3 ? 'good' : data.prDays <= 14 ? 'warning' : 'bad');
                }
            }
            if (data.divergeStatus !== undefined) {
                const branchCell = document.getElementById('branch-' + data.index);
                if (branchCell) {
                    branchCell.querySelectorAll('.chip').forEach(c => c.remove());
                    branchCell.innerHTML += renderCloneChips(data);
                }
            }
        });

        onSSE(eventSource, 'ai-log', data => {
            const logEl = document.getElementById('ai-log-' + data.index);
            logEl.textContent += data.text;
            const tooltip = document.getElementById('prompt-tooltip-' + data.index);
            if (tooltip) tooltip.textContent = logEl.textContent;
        });

        onSSE(eventSource, 'ai-done', data => {
            if (phaseTimers[data.index]) { clearInterval(phaseTimers[data.index]); delete phaseTimers[data.index]; }
            const cell = document.getElementById('status-' + data.index);
            if (data.lastCommentAt) {
                const row = cell.closest('tr');
                if (row) row.setAttribute('data-last-comment', data.lastCommentAt);
            }
            const logDiv = document.getElementById('ai-log-' + data.index);
            logDiv.textContent += '\\\\n--- Result ---\\\\n' + JSON.stringify({statusText: data.statusText, statusClass: data.statusClass, correspondence: data.correspondence}, null, 2);
            const copyBtn = cell.querySelector('.copy-prompt');
            if (copyBtn) copyBtn.setAttribute('data-preview', logDiv.textContent.slice(0, 500) + (logDiv.textContent.length > 500 ? '...' : ''));
            const statusSpan = cell.querySelector('.status-text');
            statusSpan.className = 'status-text';
            statusSpan.textContent = data.statusText;
            cell.className = 'status-col status-' + data.statusClass;
            // Render correspondence citations
            const corrDiv = document.getElementById('corr-' + data.index);
            if (corrDiv && data.correspondence && data.correspondence.length) {
                corrDiv.innerHTML = data.correspondence.map(entry => {
                    const author = (entry.author || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    const text = (entry.text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                    const textHtml = entry.url ? '<a href="' + entry.url + '" target="_blank">' + text + '</a>' : text;
                    return '<div class="corr-entry"><span class="corr-author">@' + author + ':</span> ' + textHtml + '</div>';
                }).join('');
            }
            const archBtn = document.getElementById('archive-btn-' + data.index);
            if (archBtn) {
                const urlEsc = archBtn.closest('tr').getAttribute('data-url');
                archBtn.classList.remove('action-btn-disabled');
                archBtn.setAttribute('onclick', "archiveItem('" + urlEsc.replace(/'/g, '&#39;') + "', this)");
                archBtn.innerHTML = 'ARCHIVE<span class="archive-tooltip">YOU WILL NOT SEE UPDATES FOR THIS PR!!!</span>';
            }
            // AI says this item is unimportant — hide and update info (unless user marked it important)
            if (data.autoArchive) {
                const aiRow = cell.closest('tr');
                if (aiRow && !aiRow.getAttribute('data-archived') && !aiRow.getAttribute('data-unimportant') && !aiRow.getAttribute('data-marked-important')) {
                    aiRow.setAttribute('data-unimportant', '1');
                    aiRow.style.display = 'none';
                    updateHeadingCount(aiRow, -1);
                    updateCorrespondenceTab();
                    updateInfoCount('unimportant', 1);
                }
            }
        });

        onSSE(eventSource, 'ai-error', () => {});

        function handleNewComments(url, opts) {
            const rows = document.querySelectorAll('#tab-correspondence tr[data-url="' + url.replace(/"/g, '\\\\"') + '"]');
            rows.forEach(row => {
                opts.attrs.forEach(attr => row.removeAttribute(attr));
                row.style.display = '';
                updateHeadingCount(row, 1);
                if (opts.onRow) opts.onRow(row);
                const rowIdx = parseInt(row.getAttribute('data-idx'));
                if (!isNaN(rowIdx) && !enqueued[rowIdx]) {
                    enqueued[rowIdx] = true;
                    pendingEnqueue.push(rowIdx);
                    if (!enqueueTimer) enqueueTimer = setTimeout(flushEnqueue, 50);
                }
            });
            updateInfoCount(opts.infoPrefix, -1);
            updateCorrespondenceTab();
        }

        onSSE(eventSource, 'auto-unarchive', data => {
            handleNewComments(data.url, {
                attrs: ['data-archived'],
                infoPrefix: 'archive',
                onRow: row => {
                    const titleCol = row.querySelector('.title-col');
                    if (titleCol && !titleCol.querySelector('.unarchived-badge')) {
                        titleCol.insertAdjacentHTML('beforeend', makeChip('unarchived: new comments', 'yellow', 'unarchived-badge'));
                    }
                },
            });
        });

        onSSE(eventSource, 'reset-unimportant', data => {
            handleNewComments(data.url, {
                attrs: ['data-unimportant', 'data-marked-important'],
                infoPrefix: 'unimportant',
                onRow: row => {
                    row.querySelector('.important-badge')?.remove();
                },
            });
        });

        eventSource.onerror = () => {
            if (eventSource.readyState === EventSource.CLOSED) return;
            eventSource.close();
            console.error('AI stream connection lost');
        };

        document.querySelectorAll('.status-text').forEach(span => span.classList.add('loading'));

        // Lazy-load: only request AI processing for items visible in the viewport
        const enqueued = {};
        const pendingEnqueue = [];
        let enqueueTimer = null;

        function flushEnqueue() {
            enqueueTimer = null;
            if (pendingEnqueue.length === 0) return;
            const indices = pendingEnqueue.slice();
            pendingEnqueue.length = 0;
            fetch('/api/ai-enqueue', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ indices })
            }).then(resp => { if (!resp.ok) return resp.json().then(data => { throw new Error(data.error || 'HTTP ' + resp.status); }); });
        }

        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const rowIdx = parseInt(entry.target.getAttribute('data-idx'));
                if (isNaN(rowIdx) || enqueued[rowIdx]) return;
                enqueued[rowIdx] = true;
                pendingEnqueue.push(rowIdx);
                observer.unobserve(entry.target);
            });
            if (pendingEnqueue.length > 0 && !enqueueTimer) {
                enqueueTimer = setTimeout(flushEnqueue, 50);
            }
        }, { rootMargin: '200%' });

        document.querySelectorAll('[id^="status-"]').forEach(cell => {
            const cellIdx = parseInt(cell.id.replace('status-', ''));
            const row = cell.closest('tr');
            if (row) {
                row.setAttribute('data-idx', cellIdx);
                observer.observe(row);
            }
        });
    </script>
    <script>const INSTALLED_IDES = ${JSON.stringify(installedIDEs)};</script>
    <script src="/public/repo-picker.js"></script>
</body>
</html>`;
}
