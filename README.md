# github-status

A local dashboard that shows your open GitHub PRs, PRs waiting for your review, and PRs where you were mentioned — across all repositories. It uses the `gh` CLI to fetch data and `claude` CLI to generate AI-powered review summaries. Runs as a persistent service via pm2.

<img width="1375" height="1323" alt="image" src="https://github.com/user-attachments/assets/6e42bfac-f8ee-4c83-97bd-8bbf9b62164a" />

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

Open http://localhost:7777

Custom port: `PORT=9999 ./enable.sh`

## Update
```bash
cd github-status
pm2 stop github-status
git pull origin HEAD
pm2 start github-status
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
