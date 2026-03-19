# github-status

A local dashboard that shows your open GitHub PRs, PRs waiting for your review, and PRs where you were mentioned — across all repositories. It uses the `gh` CLI to fetch data and `claude` CLI to generate AI-powered review summaries. Runs as a persistent service via pm2.

<img width="1461" height="707" alt="image" src="https://github.com/user-attachments/assets/eb1ec482-d059-4cbd-9d68-b240aa9d3fb7" />


## Prerequisites

- Node.js
- [`gh` CLI](https://cli.github.com/) (authenticated)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)

## Setup

```bash
git clone https://github.com/Romex91/github-status.git
cd github-status
./enable.sh
```

## Disable

```bash
./disable.sh
```

## Logs

```bash
pm2 logs github-status
```

## Restart

```bash
pm2 restart github-status
```
