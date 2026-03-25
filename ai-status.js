import { runCmd, CHAOS, CMD_TIMEOUT } from './helpers.js';
import { readCacheEntry, writeCacheEntry, hashPrompt, cleanAiCache } from './ai-cache.js';
import { fetchIssueDetails, fetchPRSummary, fetchPRPromptData, fetchRecentComments } from './github-api.js';
import { cleanChatPrompts } from './launch-chat.js';

// === Timeline / Context / Prompt Builders ===

function buildTimeline(d) {
  const entries = [];
  const botLogins = new Set();

  // Issue-level comments
  const commentReactions = d.commentReactions || new Map();
  for (const c of (d.comments || [])) {
    // Extract numeric comment ID from URL (e.g. #issuecomment-12345 → 12345)
    const commentId = c.url ? parseInt(c.url.split('-').pop()) : null;
    const reactions = commentReactions.get(commentId) || '';
    entries.push({
      timestamp: c.createdAt,
      author: c.author?.login,
      type: 'comment',
      threadId: null,
      body: c.body || '',
      url: c.url || null,
      reactions,
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

  // Commits
  for (const c of (d.commits || [])) {
    entries.push({
      timestamp: c.date,
      author: c.author,
      type: 'commit',
      body: `${c.sha} ${c.message}`,
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
      url: rc.url || null,
      htmlUrl: d.htmlUrl || null,
      commentId: rc.id,
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
      const urlSuffix = e.url ? ` (comment url:${e.url})` : '';
      const reactionsSuffix = e.reactions ? ` reactions:${e.reactions}` : '';
      const prefix = `[${ts}] @${e.author} [${e.type}]${id}${thread}${path}${urlSuffix}${reactionsSuffix}`;
      const diffContext = e.diffHunk ? `\n    \`\`\` diff ${e.path}:${e.line}\n    ${e.diffHunk.split('\n').slice(-5).join('\n    ')}\n    \`\`\`` : '';
      const body = e.body.slice(0, 300).replace(/\n/g, '\n  ');
      return `${prefix}${diffContext}\n  ${body}`;
    });
}

export function buildContextForPR(pr) {
  const d = pr.details || {};

  const timeline = buildTimeline(d);

  const checks = (d.statusCheckRollup || []).map(c => ({
    name: c.name || c.context || '',
    state: c.state || c.conclusion || c.status || '',
    url: c.detailsUrl || c.targetUrl || '',
  }));

  const typeMap = { mine: 'My PR', review: 'Review requested from me', mentioned: 'Mentioned in this PR', 'commented-pr': 'I commented on this PR' };

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

export function buildPromptForPR(pr, ghUsername) {
  const context = buildContextForPR(pr);

  const correspondenceRules = `
- correspondence: Your primary focus. Return a "correspondence" array of ALL relevant conversation starting from the first time ${ghUsername} appears, in chronological order. Very important to extract ALL citations so outside readers understand what happened without opening the PR.
- statusText: if there was a response, or conversation is just hanging waiting somebody. What is the current state of the discussion involving ${ghUsername}?
- Consider emoji reactions as implicit response (e.g. thumbs-up on a comment means acknowledgment). Mention reactions in statusText.
- Consider appropriate code change as implicit response. Mention in statusText
- good: discussion resolved, my points addressed, or PR state makes it moot
- warning: discussion ongoing, may need my input
- bad: ${ghUsername} was asked something and haven't responded, or my comment was ignored
- autoArchive: set to true if ${ghUsername}'s involvement is trivial and not worth tracking. Examples: only approved with "LGTM", only left emoji reactions, only short acknowledgments like "thanks" or "looks good". If there is any meaningful conversation, code review feedback, or unresolved questions involving ${ghUsername}, set to false.`;

  const mentionedRules = correspondenceRules;
  const commentedRules = correspondenceRules;

  const standardRules = `
- statusText should contain the most important details about the PR: ongoing discussions, unfixed issues, pending tasks, or if it's time to ping reviewers. Pick details that are most important for me.
- ALWAYS prefix usernames with @ in statusText (e.g. @alice, @bob). Never write bare usernames.
- Check approval requirements: reviewDecision "APPROVED" means all branch protection requirements are met. "REVIEW_REQUIRED" means approvals are still needed — mention pending reviewers by name.
- good: Approved + CI green/no CI = ready to merge
- warning: Awaiting review with CI passing/no CI, or approved with CI failures, or CI still running. Some questions or concerns are left unanswered. Mention who still needs to review.
- bad: CI failures without approval, or stale 50+ days
- For review-requested PRs: focus on what the reviewer needs to know`;

  const isCorrespondence = pr.section === 'mentioned' || pr.section === 'commented-pr';
  const rules = pr.section === 'mentioned' ? mentionedRules : pr.section === 'commented-pr' ? commentedRules : standardRules;
  const returnShape = isCorrespondence
    ? '{"statusText":"<description>","statusClass":"<good|warning|bad>","autoArchive":<true|false>,"correspondence":[{"author":"<username>","text":"<comment summary>","url":"<comment URL>"}]}'
    : '{"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>","ciUrl":"<failing CI URL or null>"}';

  return `You are a JSON API. Analyze this GitHub PR and return ONLY a single JSON object (no markdown fences, no explanation).

${context}

Return: ${returnShape}

Rules:${rules}`;
}

export function buildContextForIssue(issue) {
  const d = issue.details || {};

  const issueCommentReactions = d.commentReactions || new Map();
  const comments = (d.comments || [])
    .map(c => {
      const urlSuffix = c.url ? ` (comment url:${c.url})` : '';
      const commentId = c.url ? parseInt(c.url.split('-').pop()) : null;
      const reactions = issueCommentReactions.get(commentId) || '';
      const reactionsSuffix = reactions ? ` reactions:${reactions}` : '';
      return `@${c.author?.login}${urlSuffix}${reactionsSuffix}:\n  ${(c.body || '').slice(0, 300).replace(/\n/g, '\n  ')}`;
    });

  const assignees = (d.assignees || []).map(a => a.login);

  const typeMap = { 'assigned-issue': 'Assigned to me', 'mentioned-issue': 'Mentioned in this issue', 'created-issue': 'Created by me', 'commented-issue': 'I commented on this issue' };

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

export function buildPromptForIssue(issue, ghUsername) {
  const context = buildContextForIssue(issue);

  const isCorrespondence = issue.section === 'mentioned-issue' || issue.section === 'commented-issue';

  const standardRules = `
- ALWAYS start statusText with "Waiting on @username:" or "Action needed by @username:" identifying who must act next based on the comment thread
- If no comments exist, use the assignee(s). If no assignee, use the issue author.
- bad: I (${ghUsername}) need to take action and haven't yet
- warning: Issue is active, may need my attention soon, or I should check in
- good: No action needed from me right now (waiting on others, stale/low-priority, or I already responded)
- Be specific about what action is needed if any`;

  const correspondenceIssueRules = `
- correspondence: Your primary focus. Return a "correspondence" array of ALL relevant conversation starting from the first time ${ghUsername} appears, in chronological order. Very important to extract ALL citations so outside readers understand what happened without opening the issue.
- statusText: if there was a response, or conversation is just hanging waiting somebody. What is the current state of the discussion involving ${ghUsername}?
- Consider emoji reactions as implicit response (e.g. thumbs-up on a comment means acknowledgment). Mention reactions in statusText.
- If no response yet but issue is closed, note that it's resolved
- good: discussion resolved, my points addressed, or issue closed
- warning: discussion ongoing, may need my input
- bad: ${ghUsername} was asked something and haven't responded, or my comment was ignored
- autoArchive: set to true if ${ghUsername}'s involvement is trivial and not worth tracking. Examples: only left emoji reactions, only short acknowledgments like "thanks" or "looks good". If there is any meaningful conversation or unresolved questions involving ${ghUsername}, set to false.`;

  const mentionedIssueRules = correspondenceIssueRules;
  const commentedIssueRules = correspondenceIssueRules;

  const rules = issue.section === 'mentioned-issue' ? mentionedIssueRules : issue.section === 'commented-issue' ? commentedIssueRules : standardRules;
  const returnShape = isCorrespondence
    ? '{"statusText":"<description>","statusClass":"<good|warning|bad>","autoArchive":<true|false>,"correspondence":[{"author":"<username>","text":"<comment summary>","url":"<comment URL>"}]}'
    : '{"statusText":"<10-20 word description>","statusClass":"<good|warning|bad>"}';

  return `You are a JSON API. Analyze this GitHub issue and return ONLY a single JSON object (no markdown fences, no explanation).

My GitHub username is: ${ghUsername}

${context}

Return: ${returnShape}

Rules:${rules}`;
}

function buildPromptForItem(item, ghUsername) {
  if (item.isIssue) return buildPromptForIssue(item, ghUsername);
  return buildPromptForPR(item, ghUsername);
}

function buildContextForItem(item) {
  if (item.isIssue) return buildContextForIssue(item);
  return buildContextForPR(item);
}

// === SSE: Phase 2 - Stream AI status generation per PR ===

export function handleAIStream(req, res, { allItems, ghUsername, ghVersion, claudeVersion, onEnqueueReady, archivedUrls, onAutoUnarchive, clearAutoUnarchived, onMarkUnimportant, unimportantUrls, onResetUnimportant }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let closed = false;
  req.on('close', () => { closed = true; onEnqueueReady(null); cleanAiCache(); cleanChatPrompts(); });

  // Badges were already rendered in the HTML; clear the list so they don't persist next reload
  if (clearAutoUnarchived) clearAutoUnarchived();

  function send(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  if (!allItems) {
    send('ai-error', { index: 0, error: new Error('No PR data available. Reload the page.').stack });
    res.end();
    return;
  }

  const allPRs = allItems;
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

  const itemPhase = {};
  const completed = new Set();
  const aborted = new Set();

  function sendIfActive(index, event, data) {
    if (aborted.has(index)) return;
    send(event, data);
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
      pr.details = { ...summary, ...promptData, htmlUrl: pr.html_url };
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

    // Compute lastCommentAt: max timestamp across all comments/reviews
    const timestamps = [];
    const d = pr.details || {};
    for (const c of (d.comments || [])) if (c.createdAt) timestamps.push(c.createdAt);
    for (const r of (d.reviews || [])) if (r.submittedAt) timestamps.push(r.submittedAt);
    for (const rc of (d.reviewComments || [])) if (rc.created_at) timestamps.push(rc.created_at);
    const lastCommentAt = timestamps.length ? timestamps.sort().pop() : null;

    let prompt = buildPromptForItem(pr, ghUsername);
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
      const cachedAutoArchive = cached.autoArchive || false;
      if (cachedAutoArchive) onMarkUnimportant(pr.html_url, pr.title, lastCommentAt);
      sendIfActive(index, 'ai-done', { index, statusText, statusClass, ciUrl: cached.ciUrl || null, correspondence: cached.correspondence || null, autoArchive: cachedAutoArchive, lastCommentAt });
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
    const rawCorrespondence = status.correspondence || null;
    const rawAutoArchive = status.autoArchive === true;
    writeCacheEntry(cacheKey, {
      statusText: rawStatusText,
      statusClass: rawStatusClass,
      ciUrl: rawCiUrl,
      correspondence: rawCorrespondence,
      autoArchive: rawAutoArchive,
      timestamp: new Date().toISOString(),
    });
    const { statusText, statusClass } = applyOverrides(pr, rawStatusText, rawStatusClass);
    pr.aiStatus = statusText;
    if (rawAutoArchive) onMarkUnimportant(pr.html_url, pr.title, lastCommentAt);
    sendIfActive(index, 'ai-done', { index, statusText, statusClass, ciUrl: rawCiUrl, correspondence: rawCorrespondence, autoArchive: rawAutoArchive, lastCommentAt });
  }

  async function runOne(index) {
    const pr = allPRs[index];
    const ac = new AbortController();
    let timer;
    const inner = runOneInner(index, ac.signal);
    // eslint-disable-next-line no-restricted-syntax -- top-level error handler: catches runCmd/timeout failures and sends ai-error SSE to FE
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
        .catch(e => send('ai-error', { index: idx, error: e.stack || e.message }))
        .finally(() => { running.delete(p); drain(); });
      running.add(p);
    }
  }

  onEnqueueReady(function(indices) {
    for (const idx of indices) {
      if (queued.has(idx) || idx < 0 || idx >= allPRs.length) continue;
      queued.add(idx);
      waiting.push(idx);
    }
    drain();
  });

  // Fire-and-forget: check archived and unimportant items for new comments
  if (archivedUrls && onAutoUnarchive && Object.keys(archivedUrls).length) {
    checkNewComments(archivedUrls, send, 'auto-unarchive', onAutoUnarchive, () => closed);
  }
  if (unimportantUrls && onResetUnimportant && Object.keys(unimportantUrls).length) {
    checkNewComments(unimportantUrls, send, 'reset-unimportant', onResetUnimportant, () => closed);
  }
}

async function checkNewComments(urlMap, send, eventName, onMatch, isClosed) {
  for (const [url, entry] of Object.entries(urlMap)) {
    if (isClosed()) break;

    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)/);
    if (!match) continue;
    const [, repo, type, numStr] = match;
    const number = parseInt(numStr);

    let comments;
    // eslint-disable-next-line no-restricted-syntax -- skip items where comment fetch fails (deleted repo, permissions, etc)
    try {
      comments = await fetchRecentComments(repo, number, { isPR: type === 'pull' });
    } catch {
      continue;
    }
    if (entry.lastCommentAt) comments = comments.filter(c => c.createdAt > entry.lastCommentAt);
    if (!comments.length) continue;

    if (!isClosed()) {
      onMatch(url);
      send(eventName, { url });
    }
  }
}
