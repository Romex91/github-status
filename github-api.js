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

export async function fetchMentionedPRs(log) {
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

export async function fetchMentionedIssues(log) {
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

export async function fetchIssueDetails(repo, number, signal) {
  const raw = await gh('issue', 'view', String(number), '--repo', repo,
    '--json', 'comments,labels,body,assignees', signal);
  return JSON.parse(raw);
}

export async function fetchPRSummary(repo, number, signal) {
  const raw = await gh('pr', 'view', String(number), '--repo', repo,
    '--json', 'reviewDecision,statusCheckRollup,comments,reviews,reviewRequests,latestReviews,updatedAt,isDraft,mergeable,labels,body,headRefName,headRefOid', signal);
  return JSON.parse(raw);
}

export async function fetchPRPromptData(repo, number, signal) {
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
