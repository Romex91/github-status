# github-status

A local dashboard that shows your open GitHub PRs, PRs waiting for your review, and PRs where you were mentioned — across all repositories. It uses the `gh` CLI to fetch data and `claude` CLI to generate AI-powered review summaries. Runs as a persistent service via pm2.

<img width="1100" height="714" alt="image" src="https://github.com/user-attachments/assets/24275f60-f440-4006-86b3-90dd1e3a523b" />

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
Dashboard will auto-notify if there are fresh commits in this repo

```bash
cd ~/github-status && ./update.sh
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
