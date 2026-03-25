import { gh } from './helpers.js';

export async function fetchMyPRs(log) {
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

export async function fetchReviewPRs(log) {
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

export async function fetchMentionedPRs(log, since) {
  log(`Fetching PRs I was mentioned in (since ${since})...`, 'info');
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

export async function fetchAssignedIssues(log) {
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

export async function fetchMentionedIssues(log, since) {
  log(`Fetching issues I was mentioned in (since ${since})...`, 'info');
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

export async function fetchCreatedIssues(log) {
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

export async function fetchCommentedPRs(log, since) {
  log(`Fetching PRs I commented on (since ${since})...`, 'info');
  const raw = await gh('api', `search/issues?q=commenter:@me+type:pr+updated:>${since}&per_page=100&sort=updated&order=desc`);
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
  log(`Found ${prs.length} commented PRs`, 'success');
  return prs;
}

export async function fetchCommentedIssues(log, since) {
  log(`Fetching issues I commented on (since ${since})...`, 'info');
  const raw = await gh('api', `search/issues?q=commenter:@me+type:issue+updated:>${since}&per_page=100&sort=updated&order=desc`);
  const data = JSON.parse(raw);
  const issues = data.items.map(item => ({
    title: item.title,
    html_url: item.html_url,
    repo: item.repository_url.split('/').slice(-2).join('/'),
    number: item.number,
    updated_at: item.updated_at,
  }));
  log(`Found ${issues.length} commented issues`, 'success');
  return issues;
}

export async function fetchIssueDetails(repo, number, signal) {
  const [owner, name] = repo.split('/');
  const query = `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${number}){body,labels(first:20){nodes{name}},assignees(first:20){nodes{login}},comments(first:100){nodes{databaseId,body,createdAt,url,author{login},reactions(first:20){nodes{content,user{login}}}}}}}}`;
  const raw = await gh('api', 'graphql', '-f', `query=${query}`, signal);
  const issue = JSON.parse(raw).data.repository.issue;
  const commentReactions = new Map();
  const comments = (issue.comments?.nodes || []).map(c => {
    const reactions = (c.reactions?.nodes || []);
    if (reactions.length) {
      const grouped = {};
      for (const r of reactions) {
        if (!grouped[r.content]) grouped[r.content] = [];
        grouped[r.content].push(r.user?.login || '?');
      }
      commentReactions.set(c.databaseId, Object.entries(grouped).map(([k, v]) => `${k}:${v.join(',')}`).join(' '));
    }
    return { author: c.author, body: c.body, createdAt: c.createdAt, url: c.url };
  });
  return {
    body: issue.body,
    labels: (issue.labels?.nodes || []),
    assignees: (issue.assignees?.nodes || []),
    comments,
    commentReactions,
  };
}

export async function fetchPRSummary(repo, number, signal) {
  const raw = await gh('pr', 'view', String(number), '--repo', repo,
    '--json', 'reviewDecision,statusCheckRollup,comments,reviews,reviewRequests,latestReviews,updatedAt,isDraft,mergeable,labels,body,headRefName,headRefOid', signal);
  return JSON.parse(raw);
}

export async function fetchPRPromptData(repo, number, signal) {
  const [owner, name] = repo.split('/');
  const threadsQuery = `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){url,comments(first:100){nodes{databaseId,reactions(first:20){nodes{content,user{login}}}}},reviewThreads(first:100){nodes{isOutdated,comments(first:100){nodes{databaseId,path,createdAt,body,author{login},replyTo{databaseId},line,originalLine,diffHunk}}}}}}}`;
  const [diffRaw, threadsRaw] = await Promise.all([
    gh('pr', 'diff', String(number), '--repo', repo, signal),
    gh('api', 'graphql', '-f', `query=${threadsQuery}`, signal),
  ]);
  const prData = JSON.parse(threadsRaw).data.repository.pullRequest;
  const prUrl = prData.url;
  // Build map of comment reactions with usernames
  const commentReactions = new Map();
  for (const c of (prData.comments?.nodes || [])) {
    const reactions = (c.reactions?.nodes || []);
    if (reactions.length) {
      const grouped = {};
      for (const r of reactions) {
        if (!grouped[r.content]) grouped[r.content] = [];
        grouped[r.content].push(r.user?.login || '?');
      }
      commentReactions.set(c.databaseId, Object.entries(grouped).map(([k, v]) => `${k}:${v.join(',')}`).join(' '));
    }
  }
  const threads = prData.reviewThreads.nodes;
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
        url: `${prUrl}#discussion_r${c.databaseId}`,
      });
    }
  }
  return {
    diff: diffRaw.length > 20000 ? diffRaw.slice(0, 20000) + '\n... (truncated)' : diffRaw,
    reviewComments,
    commentReactions,
  };
}
