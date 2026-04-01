// ─── Styles (injected once) ────────────────────────────────────────────

let _dialogStylesInjected = false;
function ensureStyles() {
  if (_dialogStylesInjected) return;
  _dialogStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = '\
.dlg-overlay { position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:299; }\
.dlg-modal { position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;z-index:300;max-width:1200px;width:90%;max-height:80vh;overflow-y:auto;font-size:12px;color:#c9d1d9;font-family:"JetBrains Mono",monospace; }\
.dlg-title { font-size:14px;font-weight:600;color:#c9d1d9;margin:0 0 4px 0; }\
.dlg-subtitle { font-size:11px;color:#8b949e;margin:0 0 12px 0; }\
.dlg-section { font-size:11px;color:#58a6ff;margin:12px 0 6px 0;font-weight:600; }\
.dlg-clone-list { list-style:none;padding:0;margin:0; }\
.dlg-clone-row { display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;margin-bottom:4px;background:#0d1117; }\
.dlg-clone-row:hover { background:#1c2128; }\
.dlg-clone-path { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9; }\
.dlg-clone-branch { color:#8b949e;font-size:11px;white-space:nowrap; }\
.dlg-actions { display:flex;gap:6px;flex-shrink:0; }\
.dlg-btn { background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;font-family:inherit;font-size:11px;cursor:pointer;white-space:nowrap; }\
.dlg-btn:hover { border-color:#58a6ff;color:#58a6ff; }\
.dlg-btn:disabled { opacity:0.4;cursor:not-allowed; }\
.dlg-btn:disabled:hover { border-color:#30363d;color:#c9d1d9; }\
.dlg-btn-primary { background:#1f6feb;border-color:#1f6feb;color:#fff; }\
.dlg-btn-primary:hover { background:#388bfd;border-color:#388bfd;color:#fff; }\
.dlg-footer { display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid #30363d; }\
.dlg-spinner { display:inline-block;width:14px;height:14px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:dlg-spin 0.6s linear infinite;vertical-align:middle;margin-right:6px; }\
@keyframes dlg-spin { to { transform:rotate(360deg); } }\
.dlg-empty { color:#8b949e;font-size:11px;padding:8px 0; }\
.dlg-error { color:#f85149;font-size:11px;padding:8px 0; }\
.dlg-dirty-files { font-size:10px;color:#8b949e;margin:2px 0 0 16px;max-height:60px;overflow-y:auto;white-space:pre; }\
.dlg-clone-input-row { display:flex;align-items:center;gap:8px;margin-top:8px; }\
.dlg-clone-input { flex:1;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:4px 8px;color:#c9d1d9;font-family:inherit;font-size:11px;outline:none; }\
.dlg-clone-input:focus { border-color:#58a6ff; }\
';
  document.head.appendChild(style);
}

// ─── Dialog core ───────────────────────────────────────────────────────

function createDialog() {
  ensureStyles();
  const overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  const modal = document.createElement('div');
  modal.className = 'dlg-modal';
  document.body.appendChild(overlay);
  document.body.appendChild(modal);

  const close = () => { overlay.remove(); modal.remove(); };
  overlay.onclick = close;
  return { modal, close };
}

// ─── Repo selection dialog ──────────────────────────────────────────────

function showRepoSelectionDialog(index) {
  const dlg = createDialog();
  dlg.modal.innerHTML = '<div class="dlg-title">Scanning local repositories\u2026</div>' +
    '<div style="padding:12px 0"><span class="dlg-spinner"></span> Looking for matching clones</div>';

  fetch('/api/repo-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, rescan: true })
  })
    .then(resp => resp.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      renderRepoSelectionDialog(dlg, data, index);
    });
}

function renderRepoSelectionDialog(dlg, data, index) {
  const type = data.isIssue ? 'Issue' : 'PR';
  let html = '<div class="dlg-title">' + esc(type + ' #' + data.number + ' \u2014 ' + data.title) + '</div>';
  if (data.aiStatus) {
    html += '<div class="dlg-subtitle">' + esc(data.aiStatus) + '</div>';
  }

  if (data.clones.length === 0) {
    html += '<div class="dlg-empty">No local clone of ' + esc(data.repo) + ' found.</div>';
  } else {
    html += '<div class="dlg-section">Local clones of ' + esc(data.repo) + '</div>';
    html += '<ul class="dlg-clone-list">';
    for (const clone of data.clones) {
      html += renderCloneRow(clone, data.branch);
    }
    html += '</ul>';
  }

  if (data.branch) {
    html += '<div id="dlg-new-clone-area"></div>';
  }

  html += '<div class="dlg-footer">';
  if (data.branch) {
    html += '<button class="dlg-btn" id="dlg-new-clone-btn">New clone\u2026</button>';
  }
  html += '<button class="dlg-btn" data-action="cancel">Cancel</button>';
  html += '</div>';

  dlg.modal.innerHTML = html;

  // "New clone" button reveals an input field
  const newCloneBtn = dlg.modal.querySelector('#dlg-new-clone-btn');
  if (newCloneBtn) {
    newCloneBtn.onclick = () => {
      newCloneBtn.style.display = 'none';
      const area = dlg.modal.querySelector('#dlg-new-clone-area');
      area.innerHTML = '<div class="dlg-clone-input-row">' +
        '<input class="dlg-clone-input" id="dlg-clone-path" value="' + esc(data.suggestedClonePath || '') + '" />' +
        '<button class="dlg-btn dlg-btn-primary" id="dlg-clone-confirm">Clone</button>' +
        '</div>';
      const input = area.querySelector('#dlg-clone-path');
      input.focus();
      input.select();
      area.querySelector('#dlg-clone-confirm').onclick = () => {
        const path = input.value.trim();
        if (path) launchClone(dlg, index, path);
      };
      input.onkeydown = event => {
        if (event.key === 'Enter') {
          const path = input.value.trim();
          if (path) launchClone(dlg, index, path);
        }
      };
    };
  }

  // Wire up sync buttons (checkout/pull)
  dlg.modal.querySelectorAll('[data-sync]').forEach(btn => {
    btn.onclick = () => {
      const action = btn.getAttribute('data-sync');
      const clonePath = btn.getAttribute('data-clone');
      const branchName = btn.getAttribute('data-branch');
      btn.disabled = true;
      btn.textContent = action === 'pull' ? 'Pulling\u2026' : 'Checking out\u2026';
      fetch('/api/repo-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, clonePath, branch: branchName })
      })
        .then(resp => resp.json())
        .then(respData => {
          if (respData.error) throw new Error(respData.error);
          if (respData.diverged) {
            const row = btn.closest('.dlg-clone-row');
            if (row) {
              const tmp = document.createElement('ul');
              tmp.innerHTML = renderCloneRow({
                path: clonePath,
                currentBranch: row.querySelector('.dlg-clone-branch').textContent.replace(/[()]/g, ''),
                onPRBranch: true, dirty: false, changedFiles: [], divergeStatus: 'diverged'
              }, branchName);
              row.replaceWith(tmp.firstElementChild);
            }
            return;
          }
          updateInlineActions(index, clonePath);
          dlg.close();
        });
    };
  });

  // Wire up cancel button
  dlg.modal.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.onclick = () => dlg.close();
  });
}

function renderCloneRow(clone, branch) {
  const homePath = clone.path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  let html = '<li class="dlg-clone-row" style="flex-wrap:wrap">';

  // Top line: path, branch, badges
  html += '<span class="dlg-clone-path" title="' + esc(clone.path) + '">' + esc(homePath) + '</span>';
  html += '<span class="dlg-clone-branch">(' + esc(clone.currentBranch) + ')</span>';
  if (clone.onPRBranch) {
    html += makeChip('on branch', 'blue');
  }
  if (clone.dirty) {
    html += makeChip('dirty: ' + clone.changedFiles.length + ' file' + (clone.changedFiles.length !== 1 ? 's' : ''), 'yellow');
  } else {
    html += makeChip('clean', 'green');
  }
  if (clone.divergeStatus === 'diverged') {
    html += makeChip('diverged', 'red');
  } else if (clone.divergeStatus === 'behind') {
    html += makeChip('behind remote', 'yellow');
  } else if (clone.divergeStatus === 'ahead') {
    html += makeChip('ahead of remote', 'blue');
  }

  // Action buttons row
  html += '<div class="dlg-actions" style="width:100%;margin-top:4px">';
  if (clone.divergeStatus === 'diverged') {
    html += '<span style="color:#f85149;font-size:10px">Local and remote branches are diverged \u2014 resolve manually</span>';
  } else if (clone.dirty && (clone.divergeStatus === 'behind' || !clone.onPRBranch)) {
    html += '<span style="color:#f85149;font-size:10px">dirty \u2014 commit or stash first</span>';
  } else if (clone.divergeStatus === 'behind' || !clone.onPRBranch) {
    const syncLabel = !clone.onPRBranch ? 'Checkout branch' : 'Pull latest';
    const syncAction = !clone.onPRBranch ? 'checkout' : 'pull';
    html += '<button class="dlg-btn dlg-btn-primary" data-sync="' + syncAction + '" data-clone="' + esc(clone.path) + '" data-branch="' + esc(branch || '') + '">' + syncLabel + '</button>';
  } else {
    html += makeChip('ready', 'green');
  }
  html += '</div>';

  html += '</li>';

  if (clone.dirty) {
    html += '<div class="dlg-dirty-files">' + esc(clone.changedFiles.join('\n')) + '</div>';
  }
  return html;
}

function updateInlineActions(index, clonePath) {
  // Clear inline actions for other PRs that were using this clone
  if (typeof _clonePaths !== 'undefined') {
    for (const key in _clonePaths) {
      if (key !== String(index) && _clonePaths[key] === clonePath) {
        const staleEl = document.getElementById('inline-actions-' + key);
        if (staleEl) staleEl.innerHTML = '';
        // Also clear title path and branch chips for stale items
        const staleTitle = document.getElementById('title-' + key);
        if (staleTitle) { const cb = staleTitle.querySelector('.clone-badge'); if (cb) { cb.previousSibling?.remove(); cb.remove(); } }
        const staleBranch = document.getElementById('branch-' + key);
        if (staleBranch) staleBranch.querySelectorAll('.chip').forEach(c => c.remove());
        delete _clonePaths[key];
      }
    }
    _clonePaths[index] = clonePath;
  }
  // Append clone path to title cell
  const titleCell = document.getElementById('title-' + index);
  if (titleCell && !titleCell.querySelector('.clone-badge')) {
    titleCell.innerHTML += '<br><span class="clone-badge">' + esc(toHomePath(clonePath)) + '</span>';
  }
  // Append clean chip to branch cell (just synced/cloned)
  const branchCell = document.getElementById('branch-' + index);
  if (branchCell && !branchCell.querySelector('.chip')) {
    branchCell.innerHTML += makeChip('clean', 'green');
  }
  // Add chat/IDE buttons to inline actions
  const inlineEl = document.getElementById('inline-actions-' + index);
  if (!inlineEl) return;
  let html = '<span class="inline-action" onclick="inlineChat(' + index + ')">chat</span>';
  const ides = (typeof INSTALLED_IDES !== 'undefined') ? INSTALLED_IDES : [];
  for (const ide of ides) {
    const cmd = ide.cmd.replaceAll('&','&amp;').replaceAll('"','&quot;');
    html += '<span class="inline-action" onclick="inlineIDE(&quot;' + cmd + '&quot;,' + index + ')">' + ide.name.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
  }
  inlineEl.innerHTML = html;
}

function launchClone(dlg, index, clonePath) {
  dlg.modal.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'padding:8px 0;font-size:11px;color:#8b949e;';
  statusDiv.innerHTML = '<span class="dlg-spinner"></span> Cloning\u2026';
  dlg.modal.querySelector('.dlg-footer').before(statusDiv);

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, action: 'clone', clonePath })
  })
    .then(resp => resp.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      updateInlineActions(index, clonePath);
      dlg.close();
    });
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
