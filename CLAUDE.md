# GitHub Status Dashboard

## Server Restart

Use `bash restart.sh` to restart the server after code changes.

## Error Handling

**Principle: KISS.** Handlers only contain happy-path code. All errors go to `showError()` which does `console.error` + shows a sticky banner "There are errors in dev console". No inline error rendering, no retry buttons, no per-handler error logic.

EXTREMELY IMPORTANT: no try-catch-swallow blocks!!!

**Backend:** All external commands (git, gh, claude) go through `runCmd()` in `helpers.js`. POST endpoints use `handlePost()` which catches errors and returns `{ error: message }` as HTTP 500. SSE streams send errors via `ai-error` / `fatal` events with `{ error: message }`.

**Frontend:** Two layers catch everything:
1. `onSSE` wrapper — parses JSON, checks `d.error`, calls handler. If `d.error` exists or handler throws, calls `showError`. Individual SSE handlers are pure happy path.
2. Global `unhandledrejection` / `window.onerror` — catches fetch rejections and any uncaught throws. Fetch `.then()` chains throw on `d.error` responses, converting them to unhandled rejections.
