import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const d = new Date();
  const offset = d.getTimezoneOffset();
  d.setMinutes(d.getMinutes() - offset);
  return d.toISOString().slice(0, 16).replace('T', ' ');
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

async function fetchAssignedIssues(log) {
  log('Fetching issues assigned to me...', 'info');
  const raw = await gh('api', 'search/issues?q=assignee:@me+type:issue+state:open&per_page=100');
  const data = JSON.parse(raw);
  const issues = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    updated_at: item.updated_at,
  }));
  log(`Found ${issues.length} assigned issues`, 'success');
  return issues;
}

async function fetchMentionedIssues(log) {
  log('Fetching issues I was mentioned in (last 30 days)...', 'info');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const raw = await gh('api', `search/issues?q=mentions:@me+type:issue+state:open+updated:>${since}&per_page=100&sort=updated&order=desc`);
  const data = JSON.parse(raw);
  const issues = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    updated_at: item.updated_at,
  }));
  log(`Found ${issues.length} mentioned issues`, 'success');
  return issues;
}

async function fetchCreatedIssues(log) {
  log('Fetching issues I created...', 'info');
  const raw = await gh('api', 'search/issues?q=author:@me+type:issue+state:open&per_page=100');
  const data = JSON.parse(raw);
  const issues = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    updated_at: item.updated_at,
  }));
  log(`Found ${issues.length} created issues`, 'success');
  return issues;
}

async function fetchIssueDetails(repo, number) {
  const raw = await gh('issue', 'view', String(number), '--repo', repo,
    '--json', 'comments,labels,body,assignees');
  return JSON.parse(raw);
}

async function fetchPRDetails(repo, number) {
  const [detailsRaw, diffRaw, reviewCommentsRaw] = await Promise.all([
    gh('pr', 'view', String(number), '--repo', repo,
      '--json', 'reviewDecision,statusCheckRollup,comments,reviews,updatedAt,isDraft,mergeable,labels,body,headRefName'),
    gh('pr', 'diff', String(number), '--repo', repo).catch(() => '(diff unavailable)'),
    gh('api', `repos/${repo}/pulls/${number}/comments`, '--paginate').catch(() => '[]'),
  ]);
  const details = JSON.parse(detailsRaw);
  details.diff = diffRaw.length > 20000 ? diffRaw.slice(0, 20000) + '\n... (truncated)' : diffRaw;
  details.reviewComments = JSON.parse(reviewCommentsRaw);
  return details;
}

// === AI Status Generation (streaming per-PR/issue) ===

function buildPromptForItem(item) {
  if (item.isIssue) return buildPromptForIssue(item);
  return buildPromptForPR(item);
}

function buildTimeline(d) {
  const entries = [];
  const botLogins = new Set(['coderabbitai', 'shortcut-integration', 'popmenu-bot', 'cursor']);

  // Issue-level comments
  for (const c of (d.comments || [])) {
    entries.push({
      timestamp: c.createdAt,
      author: c.author?.login,
      type: 'comment',
      threadId: null,
      body: c.body || '',
    });
  }

  // Review submissions
  for (const r of (d.reviews || [])) {
    entries.push({
      timestamp: r.submittedAt,
      author: r.author?.login,
      type: `review:${r.state}`,
      threadId: null,
      body: r.body || '',
    });
  }

  // Review thread comments (line-level)
  for (const rc of (d.reviewComments || [])) {
    entries.push({
      timestamp: rc.created_at,
      author: rc.user?.login,
      type: 'review-comment',
      threadId: rc.in_reply_to_id ? String(rc.in_reply_to_id) : null,
      id: String(rc.id),
      path: rc.path,
      body: rc.body || '',
    });
  }

  entries.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  // Filter bots, format
  return entries
    .filter(e => !botLogins.has(e.author))
    .map(e => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 16) : '?';
      const thread = e.threadId ? ` [reply-to:${e.threadId}]` : '';
      const id = e.id ? ` [id:${e.id}]` : '';
      const path = e.path ? ` [${e.path}]` : '';
      const prefix = `[${ts}] @${e.author} [${e.type}]${id}${thread}${path}`;
      const indent = ' '.repeat(prefix.length + 1);
      const body = e.body.slice(0, 300).replace(/\n/g, '\n' + indent);
      return `${prefix} ${body}`;
    });
}

function buildPromptForPR(pr) {
  const d = pr.details || {};

  const timeline = buildTimeline(d);

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
    `\nTimeline (all comments/reviews, chronological):\n${timeline.length ? timeline.join('\n') : '  (none)'}`,
    `\nPR Body:\n${(d.body || '(empty)').slice(0, 1000)}`,
    `\nDiff:\n${d.diff || '(unavailable)'}`,
  ].filter(Boolean);

  const commonRules = `
- My GitHub username is: ${ghUsername}
- statusText should contain the most important details about the PR: ongoing discussions, unfixed issues, pending tasks, or if it's time to ping reviewers. Pick details that are most important for me.`;

  const mentionedRules = `${commonRules}
- For mentioned PRs: assess whether MY response or action is still needed
- If I (${ghUsername}) have already commented or reviewed on this PR, start statusText with "RESPONDED. " and use statusClass "good"
- good: I already responded, conversation resolved, PR merged/closed, or no action needed from me
- warning: Conversation is ongoing and may need my input
- bad: I was asked a question or requested an action and haven't responded`;

  const standardRules = `${commonRules}
- good: Approved + CI green/no CI = ready to merge
- warning: Awaiting review with CI passing/no CI, or approved with CI failures, or CI still running. Some questions or concerns are left unanswered.
- bad: CI failures without approval, or stale 50+ days
- For review-requested PRs: focus on what the reviewer needs to know`;

  const rules = pr.section === 'mentioned' ? mentionedRules : standardRules;

  return `You are a JSON API. Analyze this GitHub PR and return ONLY a single JSON object (no markdown fences, no explanation).

${sections.join('\n')}

Return: {"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>","ciUrl":"<failing CI URL or null>"}

Rules:${rules}`;
}

function buildPromptForIssue(issue) {
  const d = issue.details || {};

  const comments = (d.comments || [])
    .filter(c => c.author?.login !== 'coderabbitai')
    .map(c => `@${c.author?.login}: ${c.body?.slice(0, 300)}`);

  const assignees = (d.assignees || []).map(a => a.login);

  const typeMap = { 'assigned-issue': 'Assigned to me', 'mentioned-issue': 'Mentioned in this issue', 'created-issue': 'Created by me' };

  const sections = [
    `Title: ${issue.title}`,
    `Repo: ${issue.repo}`,
    `Type: ${typeMap[issue.section] || 'Unknown'}`,
    `Labels: ${(d.labels || []).map(l => l.name).join(', ') || 'none'}`,
    `Assignees: ${assignees.join(', ') || 'none'}`,
    `Days since last update: ${issue.days}`,
    `\nComments (excluding bots):\n${comments.length ? comments.join('\n') : '  (none)'}`,
    `\nIssue Body:\n${(d.body || '(empty)').slice(0, 1000)}`,
  ].filter(Boolean);

  return `You are a JSON API. Analyze this GitHub issue and return ONLY a single JSON object (no markdown fences, no explanation).

My GitHub username is: ${ghUsername}

${sections.join('\n')}

Return: {"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>"}

Rules:
- ALWAYS start statusText with "Waiting on @username:" or "Action needed by @username:" identifying who must act next based on the comment thread
- If no comments exist, use the assignee(s). If no assignee, use the issue author.
- bad: I (${ghUsername}) need to take action and haven't yet
- warning: Issue is active, may need my attention soon, or I should check in
- good: No action needed from me right now (waiting on others, stale/low-priority, or I already responded)
- Be specific about what action is needed if any`;
}

// === HTML Generation ===

const REPO_COLORS = [
  '#58a6ff', '#f778ba', '#7ee787', '#ffa657', '#d2a8ff',
  '#ff7b72', '#56d4dd', '#d29922', '#e0e037', '#f0883e',
  '#b392f0', '#85e89d', '#79e2f2', '#ffab70', '#db61a2',
];

const REPO_COLORS_PATH = new URL('./data/repo-colors.json', import.meta.url).pathname;

function loadRepoColors() {
  try { return JSON.parse(readFileSync(REPO_COLORS_PATH, 'utf8')); } catch { return {}; }
}

function saveRepoColors(map) {
  mkdirSync(new URL('./data/', import.meta.url).pathname, { recursive: true });
  writeFileSync(REPO_COLORS_PATH, JSON.stringify(map, null, 2) + '\n');
}

function updateRepoColors(repoNames) {
  const saved = loadRepoColors();
  const allRepos = [...new Set([...Object.keys(saved), ...repoNames])].sort();
  const map = {};
  allRepos.forEach((name, i) => { map[name] = REPO_COLORS[i % REPO_COLORS.length]; });
  saveRepoColors(map);
  return map;
}

let repoColorMap = loadRepoColors();

function repoColor(repoName) {
  return repoColorMap[repoName] || '#8b949e';
}

const AI_CACHE_DIR = new URL('./data/ai-cache/', import.meta.url).pathname;
mkdirSync(AI_CACHE_DIR, { recursive: true });

function readCacheEntry(key) {
  try { return JSON.parse(readFileSync(`${AI_CACHE_DIR}${key}.json`, 'utf8')); } catch { return null; }
}

function writeCacheEntry(key, entry) {
  writeFileSync(`${AI_CACHE_DIR}${key}.json`, JSON.stringify(entry, null, 2) + '\n');
}

function hashPrompt(prompt) {
  return createHash('md5').update(prompt).digest('hex');
}

function cleanAiCache(maxAgeDays = 3) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of readdirSync(AI_CACHE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(`${AI_CACHE_DIR}${file}`, 'utf8'));
      if (new Date(entry.timestamp).getTime() < cutoff) {
        unlinkSync(`${AI_CACHE_DIR}${file}`);
        removed++;
      }
    } catch { /* skip unreadable files */ }
  }
  if (removed > 0) console.log(`Cleaned ${removed} stale cache entries`);
}

function buildDashboardHtml(myPRs, reviewPRs, mentionedPRs, assignedIssues, mentionedIssues, createdIssues, date) {
  function stateBadge(state) {
    if (!state) return '';
    const colors = { open: '#3fb950', merged: '#a371f7', closed: '#f85149' };
    const color = colors[state] || '#8b949e';
    return ` <span class="state-badge" style="color:${color};border-color:${color}">${state}</span>`;
  }

  function failingCiHtml(pr) {
    const d = pr.details || {};
    const checks = (d.statusCheckRollup || []);
    const failing = checks.filter(c => {
      const state = (c.conclusion || c.state || c.status || '').toUpperCase();
      return state === 'FAILURE' || state === 'ERROR' || state === 'TIMED_OUT';
    });
    if (!failing.length) return '';
    return failing.map(c => {
      const rawName = (c.name || c.context || 'ci').replace(/^ci\/circleci:\s*/i, '');
      const name = escapeHtml(rawName);
      const url = c.detailsUrl || c.targetUrl || '';
      return url ? `<a class="ci-link" href="${escapeHtml(url)}">${name}</a>` : `<span class="ci-link">${name}</span>`;
    }).join('<br>');
  }

  function prRow(pr, includeAuthor, globalIndex, includeState) {
    const repoShort = pr.repo.split('/').pop();
    const authorSpan = includeAuthor ? ` <span class="author">@${escapeHtml(pr.author)}</span>` : '';
    const stateSpan = includeState ? stateBadge(pr.state) : '';
    const ci = failingCiHtml(pr);
    const branch = pr.details?.headRefName || '';
    const color = repoColor(repoShort);
    return `            <tr>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col"><a href="${escapeHtml(pr.html_url)}">#${pr.number} ${escapeHtml(pr.title)}</a>${authorSpan}${stateSpan}</td>
                <td class="branch-col"><span class="branch-name" onclick="copyBranch(this)" title="Click to copy">${escapeHtml(branch)}</span></td>
                <td class="status-col" id="status-${globalIndex}">
                    <a href="#" class="ai-toggle" data-index="${globalIndex}" onclick="toggleLog(${globalIndex});return false">generating...</a>
                    <div class="ai-log" id="ai-log-${globalIndex}"></div>
                </td>
                <td class="ci-col">${ci}</td>
                <td class="days-col days-${daysClass(pr.days)}">${pr.days}d</td>
            </tr>`;
  }

  function issueRow(issue, globalIndex) {
    const repoShort = issue.repo.split('/').pop();
    const color = repoColor(repoShort);
    return `            <tr>
                <td class="repo-col" style="color:${color}">${escapeHtml(repoShort)}</td>
                <td class="title-col"><a href="${escapeHtml(issue.html_url)}">#${issue.number} ${escapeHtml(issue.title)}</a></td>
                <td class="status-col" id="status-${globalIndex}">
                    <a href="#" class="ai-toggle" data-index="${globalIndex}" onclick="toggleLog(${globalIndex});return false">generating...</a>
                    <div class="ai-log" id="ai-log-${globalIndex}"></div>
                </td>
                <td class="days-col days-${daysClass(issue.days)}">${issue.days}d</td>
            </tr>`;
  }

  let idx = 0;
  const myRows = myPRs.map(pr => prRow(pr, false, idx++, false)).join('\n');
  const reviewRows = reviewPRs.map(pr => prRow(pr, true, idx++, false)).join('\n');
  const mentionedRows = mentionedPRs.map(pr => prRow(pr, true, idx++, true)).join('\n');
  const assignedIssueRows = assignedIssues.map(i => issueRow(i, idx++)).join('\n');
  const mentionedIssueRows = mentionedIssues.map(i => issueRow(i, idx++)).join('\n');
  const createdIssueRows = createdIssues.map(i => issueRow(i, idx++)).join('\n');

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
        h1.section-heading { font-size: 20px; margin: 28px 0 8px 0; color: #c9d1d9; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
        h2 { font-size: 13px; margin: 16px 0 6px 0; color: #8b949e; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; table-layout: fixed; }
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
        .repo-col { font-weight: 500; width: 8%; }
        .author { color: #8b949e; font-size: 11px; }
        .title-col { width: 30%; }
        .status-col { font-size: 11px; width: 30%; }
        .branch-col { font-size: 11px; width: 12%; }
        .branch-name { cursor: pointer; color: #8b949e; }
        .branch-name:hover { color: #58a6ff; }
        .branch-name.copied { color: #3fb950; }
        .ci-col { width: 10%; }
        .days-col { text-align: right; width: 4%; }
        .footer { color: #484f58; font-size: 11px; margin-top: 20px; }

        .state-badge { font-size: 10px; border: 1px solid; border-radius: 3px; padding: 1px 4px; margin-left: 4px; }
        .ai-toggle { cursor: pointer; color: #d29922; }
        .ai-toggle.done { cursor: default; color: inherit; }
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

    <h1 class="section-heading">Pull Requests</h1>

    <h2>My Open PRs (${myPRs.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col">Branch</th>
                <th class="status-col">Status</th>
                <th class="ci-col">CI</th>
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
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col">Branch</th>
                <th class="status-col">Status</th>
                <th class="ci-col">CI</th>
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
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="branch-col">Branch</th>
                <th class="status-col">Status</th>
                <th class="ci-col">CI</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${mentionedRows}
        </tbody>
    </table>

    <h1 class="section-heading">Issues</h1>

    <h2>Issues Assigned to Me (${assignedIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="status-col">Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${assignedIssueRows}
        </tbody>
    </table>

    <h2>Issues I Was Mentioned In (${mentionedIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="status-col">Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${mentionedIssueRows}
        </tbody>
    </table>

    <h2>Issues I Created (${createdIssues.length})</h2>
    <table>
        <thead>
            <tr>
                <th class="repo-col">Repo</th>
                <th class="title-col">Title</th>
                <th class="status-col">Status</th>
                <th class="days-col">Days</th>
            </tr>
        </thead>
        <tbody>
${createdIssueRows}
        </tbody>
    </table>

    <p class="footer">Generated ${date}</p>

    <script>
        function toggleLog(index) {
            var el = document.getElementById('ai-log-' + index);
            el.classList.toggle('visible');
        }

        function copyBranch(el) {
            var text = el.textContent;
            if (!text) return;
            navigator.clipboard.writeText(text).then(function() {
                el.classList.add('copied');
                var orig = el.textContent;
                el.textContent = 'copied!';
                setTimeout(function() {
                    el.textContent = orig;
                    el.classList.remove('copied');
                }, 1000);
            });
        }

        // Connect to AI status stream
        var es = new EventSource('/api/ai-stream');
        var completed = 0;
        var total = ${myPRs.length + reviewPRs.length + mentionedPRs.length + assignedIssues.length + mentionedIssues.length + createdIssues.length};

        es.addEventListener('ai-log', function(e) {
            var d = JSON.parse(e.data);
            var log = document.getElementById('ai-log-' + d.index);
            log.textContent += d.text;
            log.scrollTop = log.scrollHeight;
        });

        es.addEventListener('ai-done', function(e) {
            var d = JSON.parse(e.data);
            var cell = document.getElementById('status-' + d.index);
            // Keep the log div, replace the toggle link with final status
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\n--- Result ---\\n' + JSON.stringify({statusText: d.statusText, statusClass: d.statusClass}, null, 2);
            cell.className = 'status-col status-' + d.statusClass;
            cell.innerHTML = '<a href="#" class="ai-toggle done" onclick="toggleLog(' + d.index + ');return false">' +
                d.statusText.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a>' +
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
    const [myPRs, reviewPRs, rawMentionedPRs, username, assignedIssues, rawMentionedIssues, rawCreatedIssues] = await Promise.all([
      fetchMyPRs(log),
      fetchReviewPRs(log),
      fetchMentionedPRs(log),
      gh('api', 'user', '--jq', '.login').then(s => s.trim()),
      fetchAssignedIssues(log),
      fetchMentionedIssues(log),
      fetchCreatedIssues(log),
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

    log(`Fetching details for ${allPRs.length} PRs and ${allIssues.length} issues in parallel...`, 'info');

    const [detailResults, issueDetailResults] = await Promise.all([
      Promise.allSettled(
        allPRs.map(async (pr) => {
          log(`  → PR ${pr.repo}#${pr.number}`, 'info');
          return fetchPRDetails(pr.repo, pr.number);
        })
      ),
      Promise.allSettled(
        allIssues.map(async (issue) => {
          log(`  → Issue ${issue.repo}#${issue.number}`, 'info');
          return fetchIssueDetails(issue.repo, issue.number);
        })
      ),
    ]);

    detailResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allPRs[i].details = result.value;
      } else {
        log(`Failed: ${allPRs[i].repo}#${allPRs[i].number}: ${result.reason?.message}`, 'error');
        allPRs[i].details = null;
      }
      allPRs[i].days = daysSince(allPRs[i].updated_at);

      // Detect if I responded in mentioned PRs
      if (allPRs[i].section === 'mentioned' && allPRs[i].details) {
        const d = allPRs[i].details;
        const myComments = (d.comments || []).some(c => c.author?.login === username);
        const myReviews = (d.reviews || []).some(r => r.author?.login === username);
        const myReviewComments = (d.reviewComments || []).some(rc => rc.user?.login === username);
        allPRs[i].iResponded = myComments || myReviews || myReviewComments;
      }
    });

    issueDetailResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allIssues[i].details = result.value;
      } else {
        log(`Failed: ${allIssues[i].repo}#${allIssues[i].number}: ${result.reason?.message}`, 'error');
        allIssues[i].details = null;
      }
      allIssues[i].days = daysSince(allIssues[i].updated_at);
    });

    log('All details fetched. Rendering dashboard...', 'success');

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
    const html = buildDashboardHtml(myPRsForHtml, reviewPRsForHtml, mentionedPRsForHtml, assignedIssuesForHtml, mentionedIssuesForHtml, createdIssuesForHtml, date);

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

  function applyOverrides(pr, statusText, statusClass) {
    if (pr.iResponded && !statusText.startsWith('RESPONDED.')) {
      return { statusText: 'RESPONDED. ' + statusText, statusClass: 'good' };
    }
    return { statusText, statusClass };
  }

  function runOne(index) {
    return new Promise((resolve) => {
      const pr = allPRs[index];
      const prompt = buildPromptForItem(pr);
      const cacheKey = hashPrompt(prompt);

      // Check cache
      const cached = readCacheEntry(cacheKey);
      if (cached) {
        send('ai-log', { index, text: `[cached — ${cached.timestamp}]\n\n=== Prompt ===\n${prompt}\n` });
        const { statusText, statusClass } = applyOverrides(pr, cached.statusText, cached.statusClass);
        send('ai-done', { index, statusText, statusClass, ciUrl: cached.ciUrl || null });
        resolve();
        return;
      }

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
            const rawStatusText = status.statusText || 'Unknown';
            const rawStatusClass = status.statusClass || 'warning';
            const rawCiUrl = status.ciUrl || null;
            // Save cache entry immediately
            writeCacheEntry(cacheKey, {
              statusText: rawStatusText,
              statusClass: rawStatusClass,
              ciUrl: rawCiUrl,
              timestamp: new Date().toISOString(),
            });
            const { statusText, statusClass } = applyOverrides(pr, rawStatusText, rawStatusClass);
            send('ai-done', { index, statusText, statusClass, ciUrl: rawCiUrl });
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

    cleanAiCache();
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
            window.scrollTo(0, 0);
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
