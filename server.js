import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchChat } from './launch-chat.js';
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

// Emperor protects! :pray:
const CHAOS = false;

const CMD_TIMEOUT = 60000;

function runCmd(bin, args, { stdin, env: cmdEnv, signal } = {}) {
  const cmd = `${bin} ${args.join(' ')}`;
  let shellBin = bin, shellArgs = args;
  if (CHAOS) {
    const escaped = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    shellBin = 'sh';
    shellArgs = ['-c', `./bin/chaotic-testing && ${bin} ${escaped}`];
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`Aborted before start: ${cmd}`)); return; }
    const child = spawn(shellBin, shellArgs, { env: cmdEnv, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const kill = () => { child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); };
    const timer = setTimeout(kill, CMD_TIMEOUT);
    const onAbort = () => { kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (stdin) { child.stdin.write(stdin); child.stdin.end(); }
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error(`Aborted: ${cmd}`));
      else if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(code === null ? `Command timed out after ${CMD_TIMEOUT / 1000}s: ${cmd}` : `Command failed: ${cmd}\n${stderr || `Exit code ${code}`}`));
    });
    child.on('error', (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new Error(`Command failed: ${cmd}\n${err.message}`)); });
  });
}

async function gh(...args) {
  const signal = args.length && args[args.length - 1] instanceof AbortSignal ? args.pop() : undefined;
  return runCmd('gh', args, { signal });
}

// Capture tool versions at startup for error diagnostics
let ghVersion = 'unknown';
let claudeVersion = 'unknown';
runCmd('gh', ['--version']).then(v => { ghVersion = v.match(/\d+\.\d+\.\d+/)?.[0] || v.trim(); }).catch(() => {});
runCmd('claude', ['--version']).then(v => { claudeVersion = v.trim(); }).catch(() => {});

// Store PR data between phases
let pendingPRData = null;
let ghUsername = null;
let enqueueAIItems = null;

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

async function fetchIssueDetails(repo, number, signal) {
  const raw = await gh('issue', 'view', String(number), '--repo', repo,
    '--json', 'comments,labels,body,assignees', signal);
  return JSON.parse(raw);
}

async function fetchPRSummary(repo, number, signal) {
  const raw = await gh('pr', 'view', String(number), '--repo', repo,
    '--json', 'reviewDecision,statusCheckRollup,comments,reviews,reviewRequests,latestReviews,updatedAt,isDraft,mergeable,labels,body,headRefName', signal);
  return JSON.parse(raw);
}

async function fetchPRPromptData(repo, number, signal) {
  const [owner, name] = repo.split('/');
  const threadsQuery = `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){reviewThreads(first:100){nodes{isOutdated,comments(first:100){nodes{databaseId,path,createdAt,body,author{login},replyTo{databaseId},line,originalLine,diffHunk}}}}}}}`;
  const [diffRaw, threadsRaw] = await Promise.all([
    gh('pr', 'diff', String(number), '--repo', repo, signal),
    gh('api', 'graphql', '-f', `query=${threadsQuery}`, signal),
  ]);
  const threads = JSON.parse(threadsRaw).data.repository.pullRequest.reviewThreads.nodes;
  const reviewComments = [];
  for (const thread of threads) {
    for (const c of thread.comments.nodes) {
      const isRoot = !c.replyTo;
      reviewComments.push({
        id: c.databaseId,
        path: c.path,
        created_at: c.createdAt,
        body: c.body,
        user: { login: c.author?.login },
        in_reply_to_id: c.replyTo?.databaseId || null,
        isOutdated: thread.isOutdated,
        line: isRoot ? (c.line || c.originalLine) : null,
        diffHunk: isRoot ? c.diffHunk : null,
      });
    }
  }
  return {
    diff: diffRaw.length > 20000 ? diffRaw.slice(0, 20000) + '\n... (truncated)' : diffRaw,
    reviewComments,
  };
}

// === AI Status Generation (streaming per-PR/issue) ===

function buildPromptForItem(item) {
  if (item.isIssue) return buildPromptForIssue(item);
  return buildPromptForPR(item);
}

function buildContextForItem(item) {
  if (item.isIssue) return buildContextForIssue(item);
  return buildContextForPR(item);
}

function buildTimeline(d) {
  const entries = [];
  const botLogins = new Set();

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
      type: rc.isOutdated ? 'review-comment:outdated' : 'review-comment',
      threadId: rc.in_reply_to_id ? String(rc.in_reply_to_id) : null,
      id: String(rc.id),
      path: rc.path,
      line: rc.line,
      diffHunk: rc.diffHunk,
      body: rc.body || '',
    });
  }

  entries.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  // Filter bots, format
  return entries
    .filter(e => !botLogins.has(e.author) && e.body.trim())
    .map(e => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 16) : '?';
      const thread = e.threadId ? ` [reply-to:${e.threadId}]` : '';
      const id = e.id ? ` [id:${e.id}]` : '';
      const lineSuffix = e.line ? `:${e.line}` : '';
      const path = e.path ? ` [${e.path}${lineSuffix}]` : '';
      const prefix = `[${ts}] @${e.author} [${e.type}]${id}${thread}${path}`;
      const diffContext = e.diffHunk ? `\n    \`\`\` diff ${e.path}:${e.line}\n    ${e.diffHunk.split('\n').slice(-5).join('\n    ')}\n    \`\`\`` : '';
      const body = e.body.slice(0, 300).replace(/\n/g, '\n  ');
      return `${prefix}${diffContext}\n  ${body}`;
    });
}

function buildContextForPR(pr) {
  const d = pr.details || {};

  const timeline = buildTimeline(d);

  const checks = (d.statusCheckRollup || []).map(c => ({
    name: c.name || c.context || '',
    state: c.state || c.conclusion || c.status || '',
    url: c.detailsUrl || c.targetUrl || '',
  }));

  const typeMap = { mine: 'My PR', review: 'Review requested from me', mentioned: 'Mentioned in this PR' };

  const pendingReviewers = (d.reviewRequests || []).map(r => r.login || r.name || r.slug || 'unknown');
  // Resolve effective review state: COMMENTED doesn't override a prior APPROVED
  const effectiveReviewState = new Map();
  for (const r of (d.reviews || [])) {
    const login = r.author?.login;
    if (!login) continue;
    if (r.state === 'COMMENTED' && effectiveReviewState.get(login) === 'APPROVED') continue;
    effectiveReviewState.set(login, r.state);
  }
  const latestReviews = [...effectiveReviewState].map(([login, state]) => `${login}: ${state}`);

  // Detect reviewers whose comments are all in outdated threads
  const reviewerComments = new Map();
  for (const rc of (d.reviewComments || [])) {
    const author = rc.user?.login;
    if (!author) continue;
    if (!reviewerComments.has(author)) reviewerComments.set(author, { total: 0, outdated: 0 });
    const entry = reviewerComments.get(author);
    entry.total++;
    if (rc.isOutdated) entry.outdated++;
  }
  // A reviewer who approved still counts as approved even if they later left a COMMENTED review
  const approvedAuthors = new Set();
  const resolvedAuthors = new Set();
  for (const r of (d.reviews || []).slice().reverse()) {
    const login = r.author?.login;
    if (!login || resolvedAuthors.has(login)) continue;
    if (r.state === 'APPROVED') { approvedAuthors.add(login); resolvedAuthors.add(login); }
    else if (r.state !== 'COMMENTED') resolvedAuthors.add(login);
  }
  const needReReview = [];
  for (const [author, { total, outdated }] of reviewerComments) {
    if (total > 0 && total === outdated && !approvedAuthors.has(author)) needReReview.push(author);
  }

  return [
    `Title: ${pr.title}`,
    `Repo: ${pr.repo}`,
    `Type: ${typeMap[pr.section] || 'Unknown'}`,
    pr.state ? `PR State: ${pr.state}` : null,
    `Draft: ${d.isDraft || false}`,
    `Review decision: ${d.reviewDecision || 'NONE'} (reflects branch protection rules — REVIEW_REQUIRED means approval requirements are NOT yet met)`,
    `Pending review requests: ${pendingReviewers.length ? pendingReviewers.join(', ') : 'none'}`,
    `Latest reviews: ${latestReviews.length ? latestReviews.join(', ') : 'none'}`,
    needReReview.length ? `IMPORTANT! Need to re-request review from: ${needReReview.map(u => '@' + u).join(', ')} (all their comments are in outdated threads)` : null,
    `Mergeable: ${d.mergeable || 'UNKNOWN'}`,
    `Labels: ${(d.labels || []).map(l => l.name).join(', ') || 'none'}`,
    `Days since last update: ${pr.days}`,
    `\n# CI Checks:\n${checks.length ? checks.map(c => `  ${c.state} ${c.name} ${c.url}`).join('\n') : '  (none)'}`,
    `\n# Timeline (all comments/reviews, chronological):\n${timeline.length ? timeline.join('\n') : '  (none)'}`,
    `\nPR Body:\n${(d.body || '(empty)').slice(0, 1000)}`,
    `\nDiff:\n${d.diff || '(unavailable)'}`,
  ].filter(Boolean).join('\n');
}

function buildPromptForPR(pr) {
  const context = buildContextForPR(pr);

  const commonRules = `
- My GitHub username is: ${ghUsername}
- statusText should contain the most important details about the PR: ongoing discussions, unfixed issues, pending tasks, or if it's time to ping reviewers. Pick details that are most important for me.
- ALWAYS prefix usernames with @ in statusText (e.g. @alice, @bob). Never write bare usernames.`;

  const mentionedRules = `${commonRules}
- For mentioned PRs: assess whether MY response or action is still needed
- If I (${ghUsername}) have already commented or reviewed on this PR, start statusText with "RESPONDED. " and use statusClass "good"
- good: I already responded, conversation resolved, PR merged/closed, or no action needed from me
- warning: Conversation is ongoing and may need my input
- bad: I was asked a question or requested an action and haven't responded`;

  const standardRules = `${commonRules}
- Check approval requirements: reviewDecision "APPROVED" means all branch protection requirements are met. "REVIEW_REQUIRED" means approvals are still needed — mention pending reviewers by name.
- good: Approved + CI green/no CI = ready to merge
- warning: Awaiting review with CI passing/no CI, or approved with CI failures, or CI still running. Some questions or concerns are left unanswered. Mention who still needs to review.
- bad: CI failures without approval, or stale 50+ days
- For review-requested PRs: focus on what the reviewer needs to know`;

  const rules = pr.section === 'mentioned' ? mentionedRules : standardRules;

  return `You are a JSON API. Analyze this GitHub PR and return ONLY a single JSON object (no markdown fences, no explanation).

${context}

Return: {"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>","ciUrl":"<failing CI URL or null>"}

Rules:${rules}`;
}

function buildContextForIssue(issue) {
  const d = issue.details || {};

  const comments = (d.comments || [])
    .map(c => `@${c.author?.login}:\n  ${(c.body || '').slice(0, 300).replace(/\n/g, '\n  ')}`);

  const assignees = (d.assignees || []).map(a => a.login);

  const typeMap = { 'assigned-issue': 'Assigned to me', 'mentioned-issue': 'Mentioned in this issue', 'created-issue': 'Created by me' };

  return [
    `Title: ${issue.title}`,
    `Repo: ${issue.repo}`,
    `Type: ${typeMap[issue.section] || 'Unknown'}`,
    `Labels: ${(d.labels || []).map(l => l.name).join(', ') || 'none'}`,
    `Assignees: ${assignees.join(', ') || 'none'}`,
    `Days since last update: ${issue.days}`,
    `\nComments (excluding bots):\n${comments.length ? comments.join('\n') : '  (none)'}`,
    `\nIssue Body:\n${(d.body || '(empty)').slice(0, 1000)}`,
  ].filter(Boolean).join('\n');
}

function buildPromptForIssue(issue) {
  const context = buildContextForIssue(issue);

  return `You are a JSON API. Analyze this GitHub issue and return ONLY a single JSON object (no markdown fences, no explanation).

My GitHub username is: ${ghUsername}

${context}

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
  try { return JSON.parse(readFileSync(REPO_COLORS_PATH, 'utf8')); } catch (e) { console.error('Failed to load repo colors:', e); return {}; }
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
  if (CHAOS && Math.random() < 0.2) { console.error(`[CHAOS] cache read failure for ${key}`); return null; }
  try { return JSON.parse(readFileSync(`${AI_CACHE_DIR}${key}.json`, 'utf8')); } catch (e) { console.error(`Failed to read cache entry ${key}:`, e); return null; }
}

function writeCacheEntry(key, entry) {
  if (CHAOS && Math.random() < 0.2) throw new Error(`[CHAOS] cache write failure for ${key}`);
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
    } catch (e) { console.error(`Failed to process cache file ${file}:`, e); }
  }
  if (removed > 0) console.log(`Cleaned ${removed} stale cache entries`);
}

function buildDashboardHtml(myPRs, reviewPRs, mentionedPRs, assignedIssues, mentionedIssues, createdIssues, date, updateInfo) {
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
                    <br><span class="copy-prompt" onclick="copyPrompt(${globalIndex})">copy prompt<div class="prompt-tooltip" id="prompt-tooltip-${globalIndex}"></div></span><span class="chat-btn" onclick="chatPR(${globalIndex})">chat</span>
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
        .copy-prompt { cursor: pointer; color: #484f58; font-size: 10px; position: relative; }
        .copy-prompt:hover { color: #58a6ff; }
        .chat-btn { cursor: pointer; color: #484f58; font-size: 10px; margin-left: 8px; }
        .chat-btn:hover { color: #58a6ff; }
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
    </style>
</head>
<body>
    ${updateHtml}
    <h1>GitHub Status - ${date}${updateInfo ? ' <button class="update-btn" onclick="document.getElementById(\'update-overlay\').style.display=\'block\';document.getElementById(\'update-popup\').style.display=\'block\'">UPDATE AVAILABLE</button>' : ''} <span class="header-links"><a href="https://github.com/Romex91/github-status/issues/new?template=bug_report.md" target="_blank">file an issue</a> · <a href="https://github.com/Romex91/github-status/issues/new?template=feature_request.md" target="_blank">request a feature</a></span></h1>
    <div class="fold-controls"><a onclick="foldAll()">Fold all</a><a onclick="unfoldAll()">Unfold all</a></div>

    <h1 class="section-heading">Pull Requests</h1>

    <h2 onclick="this.classList.toggle('folded')">My Open PRs (${myPRs.length})</h2>
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

    <h2 onclick="this.classList.toggle('folded')">PRs Waiting for My Review (${reviewPRs.length})</h2>
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

    <h2 onclick="this.classList.toggle('folded')">PRs I Was Mentioned In (${mentionedPRs.length})</h2>
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
${mentionedRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h1 class="section-heading">Issues</h1>

    <h2 onclick="this.classList.toggle('folded')">Issues Assigned to Me (${assignedIssues.length})</h2>
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

    <h2 onclick="this.classList.toggle('folded')">Issues I Was Mentioned In (${mentionedIssues.length})</h2>
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
${mentionedIssueRows}
        </tbody>
    </table>
    <hr class="subdivider">

    <h2 onclick="this.classList.toggle('folded')">Issues I Created (${createdIssues.length})</h2>
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

    <p class="footer">Generated ${date}</p>

    <script>
        function foldAll() {
            document.querySelectorAll('h2').forEach(function(h) { h.classList.add('folded'); });
        }
        function unfoldAll() {
            document.querySelectorAll('h2').forEach(function(h) { h.classList.remove('folded'); });
        }

        function chatPR(index) {
            var btn = document.querySelector('[onclick="chatPR(' + index + ')"]');
            if (btn) btn.style.pointerEvents = 'none';
            fetch('/api/chat', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({index: index})
            }).then(function(r) { return r.json(); }).then(function(d) {
                if (btn) btn.style.pointerEvents = '';
                if (d.error) { alert('Chat: ' + d.error); return; }
                if (btn) showCopyToast(btn, 'opened terminal window');
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

        // Connect to AI status stream
        var es = new EventSource('/api/ai-stream');
        var phaseTimers = {};

        es.addEventListener('ai-phase', function(e) {
            var d = JSON.parse(e.data);
            var cell = document.getElementById('status-' + d.index);
            if (!cell) return;
            var statusSpan = cell.querySelector('.status-text');
            if (!statusSpan) return;
            var branchCell = document.getElementById('branch-' + d.index);
            var startTime = Date.now();
            if (phaseTimers[d.index]) clearInterval(phaseTimers[d.index]);
            function update() {
                var elapsed = Math.floor((Date.now() - startTime) / 1000);
                statusSpan.textContent = 'Running \`' + d.phase + '\` for ' + elapsed + 's';
                if (branchCell && branchCell.classList.contains('status-loading')) {
                    branchCell.textContent = 'Running \`' + d.phase + '\` for ' + elapsed + 's';
                }
            }
            update();
            phaseTimers[d.index] = setInterval(update, 1000);
        });

        es.addEventListener('pr-details', function(e) {
            var d = JSON.parse(e.data);
            var branchCell = document.getElementById('branch-' + d.index);
            if (branchCell) {
                branchCell.classList.remove('status-loading');
                var branch = d.branch;
                var html = '<span class="branch-name" onclick="copyBranch(this)" title="Click to copy">' + branch.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>';
                if (branch) {
                    var cmd = 'cd ~/' + d.repoShort + ' && git fetch origin ' + branch + ' && git checkout ' + branch;
                    html += '<br><span class="checkout-cmd" onclick="copyCmd(this)" data-cmd="' + cmd.replace(/"/g,'&quot;') + '">copy git checkout cmd</span>';
                }
                branchCell.innerHTML = html;
            }
            var ciCell = document.getElementById('ci-' + d.index);
            if (ciCell) {
                ciCell.classList.remove('status-loading');
                if (d.failing && d.failing.length) {
                    ciCell.innerHTML = d.failing.map(function(c) {
                        var name = (c.name || c.context || 'ci').replace(/^ci\\/circleci:\\s*/i, '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
                        var url = c.detailsUrl || c.targetUrl || '';
                        return url ? '<a class="ci-link" href="' + url.replace(/"/g,'&quot;') + '">' + name + '</a>' : '<span class="ci-link">' + name + '</span>';
                    }).join('<br>');
                } else {
                    ciCell.textContent = '';
                }
            }
        });

        es.addEventListener('ai-log', function(e) {
            var d = JSON.parse(e.data);
            var log = document.getElementById('ai-log-' + d.index);
            log.textContent += d.text;
            var btn = log.parentNode.querySelector('.copy-prompt');
            var tooltip = document.getElementById('prompt-tooltip-' + d.index);
            if (tooltip) tooltip.textContent = log.textContent;
        });

        es.addEventListener('ai-done', function(e) {
            var d = JSON.parse(e.data);
            if (phaseTimers[d.index]) { clearInterval(phaseTimers[d.index]); delete phaseTimers[d.index]; }
            var cell = document.getElementById('status-' + d.index);
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\n--- Result ---\\n' + JSON.stringify({statusText: d.statusText, statusClass: d.statusClass}, null, 2);
            var btn = cell.querySelector('.copy-prompt');
            if (btn) btn.setAttribute('data-preview', logDiv.textContent.slice(0, 500) + (logDiv.textContent.length > 500 ? '...' : ''));
            var statusSpan = cell.querySelector('.status-text');
            statusSpan.className = 'status-text';
            statusSpan.textContent = d.statusText;
            cell.className = 'status-col status-' + d.statusClass;
        });

        es.addEventListener('ai-error', function(e) {
            var d = JSON.parse(e.data);
            if (phaseTimers[d.index]) { clearInterval(phaseTimers[d.index]); delete phaseTimers[d.index]; }
            var cell = document.getElementById('status-' + d.index);
            var logDiv = document.getElementById('ai-log-' + d.index);
            logDiv.textContent += '\\nERROR: ' + d.error;
            var tooltip = document.getElementById('prompt-tooltip-' + d.index);
            if (tooltip) tooltip.textContent = logDiv.textContent;
            var statusSpan = cell.querySelector('.status-text');
            statusSpan.className = 'status-text';
            statusSpan.textContent = 'ERROR: ' + d.error;
            cell.className = 'status-col status-bad';
            var copyBtn = cell.querySelector('.copy-prompt');
            if (copyBtn) {
                copyBtn.childNodes[0].textContent = 'copy error';
                copyBtn.onclick = function() {
                    navigator.clipboard.writeText(d.error).then(function() { showCopyToast(copyBtn); });
                };
            }
        });

        es.onerror = function() {
            if (es.readyState === EventSource.CLOSED) return;
            es.close();
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
            });
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
</body>
</html>`;
}

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
    const html = buildDashboardHtml(myPRsForHtml, reviewPRsForHtml, mentionedPRsForHtml, assignedIssuesForHtml, mentionedIssuesForHtml, createdIssuesForHtml, date, updateInfo);

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

// === SSE: Phase 2 - Stream AI status generation per PR ===

function handleAIStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  req.on('close', () => { closed = true; enqueueAIItems = null; cleanAiCache(); });

  function send(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  if (!pendingPRData) {
    send('ai-error', { index: 0, error: new Error('No PR data available. Reload the page.').stack });
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

  const RUN_ONE_TIMEOUT = CMD_TIMEOUT * 3;

  function spawnClaude(prompt, signal) {
    return runCmd('claude', ['-p', '--model', 'haiku'], { stdin: prompt, env, signal });
  }

  async function runOneInner(index, signal) {
    const pr = allPRs[index];
    if (pr.fetchError) return;

    // Lazy-load all details (deferred from Phase 1 for faster table render)
    if (pr.isIssue) {
      itemPhase[index] = `gh issue view ${pr.number} --repo ${pr.repo}`;
      sendIfActive(index, 'ai-phase', { index, phase: itemPhase[index] });
      pr.details = await fetchIssueDetails(pr.repo, pr.number, signal);
    } else {
      itemPhase[index] = `gh pr view + gh pr diff + gh api comments`;
      sendIfActive(index, 'ai-phase', { index, phase: itemPhase[index] });
      const [summary, promptData] = await Promise.all([
        fetchPRSummary(pr.repo, pr.number, signal),
        fetchPRPromptData(pr.repo, pr.number, signal),
      ]);
      pr.details = { ...summary, ...promptData };
      const repoShort = pr.repo.split('/').pop();
      const branch = summary.headRefName || '';
      const failing = (summary.statusCheckRollup || []).filter(c => {
        const s = (c.conclusion || c.state || c.status || '').toUpperCase();
        return s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT';
      });
      sendIfActive(index, 'pr-details', { index, branch, repoShort, failing });
      if (pr.section === 'mentioned') {
        const myComments = (summary.comments || []).some(c => c.author?.login === ghUsername);
        const myReviews = (summary.reviews || []).some(r => r.author?.login === ghUsername);
        const myReviewComments = (promptData.reviewComments || []).some(rc => rc.user?.login === ghUsername);
        pr.iResponded = myComments || myReviews || myReviewComments;
      }
    }

    let prompt = buildPromptForItem(pr);
    pr.builtPrompt = prompt;
    pr.chatContext = buildContextForItem(pr);
    if (CHAOS && Math.random() < 0.1) {
      prompt = 'Respond with only: CHAOS REIGNS';
    }
    const cacheKey = hashPrompt(prompt);

    // Check cache
    const cached = readCacheEntry(cacheKey);
    if (cached) {
      sendIfActive(index, 'ai-log', { index, text: `[AI response was cached to save tokens — ${cached.timestamp}]\n\n=== CMD: claude -p --model haiku ===\n\n=== Prompt ===\n${prompt}\n` });
      const { statusText, statusClass } = applyOverrides(pr, cached.statusText, cached.statusClass);
      pr.aiStatus = statusText;
      sendIfActive(index, 'ai-done', { index, statusText, statusClass, ciUrl: cached.ciUrl || null });
      return;
    }

    sendIfActive(index, 'ai-log', { index, text: `=== CMD: claude -p --model haiku ===\n\n=== Prompt ===\n${prompt}\n\n=== Claude Output ===\n` });

    itemPhase[index] = 'claude -p --model haiku';
    sendIfActive(index, 'ai-phase', { index, phase: itemPhase[index] });
    const raw = await spawnClaude(prompt, signal);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const status = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const rawStatusText = status.statusText || 'Unknown';
    const rawStatusClass = status.statusClass || 'warning';
    const rawCiUrl = status.ciUrl || null;
    writeCacheEntry(cacheKey, {
      statusText: rawStatusText,
      statusClass: rawStatusClass,
      ciUrl: rawCiUrl,
      timestamp: new Date().toISOString(),
    });
    const { statusText, statusClass } = applyOverrides(pr, rawStatusText, rawStatusClass);
    pr.aiStatus = statusText;
    sendIfActive(index, 'ai-done', { index, statusText, statusClass, ciUrl: rawCiUrl });
  }

  const itemPhase = {};

  const completed = new Set();
  const aborted = new Set();

  function sendIfActive(index, event, data) {
    if (aborted.has(index)) return;
    send(event, data);
  }

  async function runOne(index) {
    const pr = allPRs[index];
    const ac = new AbortController();
    let timer;
    const inner = runOneInner(index, ac.signal);
    try {
      await Promise.race([
        inner,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`Timeout after ${RUN_ONE_TIMEOUT / 1000}s while ${itemPhase[index] || 'unknown phase'}`));
          }, RUN_ONE_TIMEOUT);
        }),
      ]);
    } catch (e) {
      inner.catch(() => {}); // swallow late rejection from orphaned inner promise
      aborted.add(index); // prevent zombie runOneInner from sending events
      const phase = itemPhase[index] || 'unknown phase';
      if (e.name === 'AbortError' || ac.signal.aborted) e = new Error(`Timeout after ${RUN_ONE_TIMEOUT / 1000}s while ${phase}`);
      console.error(`[${index}] ${pr.repo}#${pr.number} failed:`, e);
      if (!pr.isIssue) send('pr-details', { index, branch: '', repoShort: pr.repo.split('/').pop(), failing: [], error: e.message });
      const errMsg = e.message.startsWith('Timeout') ? e.message : (e.stack || e.message);
      send('ai-error', { index, error: `${errMsg}\n\n[gh ${ghVersion}, claude ${claudeVersion}]` });
    } finally {
      clearTimeout(timer);
    }
    completed.add(index);
  }

  // Lazy-load: process items on demand as they scroll into view
  const queued = new Set();
  const waiting = [];
  const running = new Set();

  function drain() {
    while (waiting.length > 0 && running.size < CONCURRENCY && !closed) {
      const idx = waiting.shift();
      const p = runOne(idx)
        .catch(e => console.error(`Unexpected runOne error for ${idx}:`, e))
        .finally(() => { running.delete(p); drain(); });
      running.add(p);
    }
  }

  enqueueAIItems = function(indices) {
    for (const idx of indices) {
      if (queued.has(idx) || idx < 0 || idx >= allPRs.length) continue;
      queued.add(idx);
      waiting.push(idx);
    }
    drain();
  };
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
        const { index } = JSON.parse(body);
        const pr = pendingPRData && pendingPRData[index];
        if (!pr) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found. Reload the page.' })); return; }
        if (!pr.chatContext) { res.writeHead(400); res.end(JSON.stringify({ error: 'AI analysis not yet complete for this item.' })); return; }

        launchChat({
          prompt: pr.chatContext,
          url: pr.html_url,
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          isIssue: pr.isIssue,
          branch: pr.details?.headRefName || '',
          aiStatus: pr.aiStatus || '',
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('Chat launch failed:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`GitHub Status server running at http://localhost:${PORT}`);
});
