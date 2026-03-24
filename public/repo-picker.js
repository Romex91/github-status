/* global showCopyToast INSTALLED_IDES */

// ─── Styles (injected once) ────────────────────────────────────────────

var _dialogStylesInjected = false;
function ensureStyles() {
  if (_dialogStylesInjected) return;
  _dialogStylesInjected = true;
  var s = document.createElement('style');
  s.textContent = '\
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
.dlg-badge { font-size:10px;padding:1px 6px;border-radius:3px;white-space:nowrap; }\
.dlg-badge-clean { background:#1a3a1a;color:#3fb950;border:1px solid #238636; }\
.dlg-badge-dirty { background:#3d1f00;color:#d29922;border:1px solid #9e6a03; }\
.dlg-badge-branch { background:#0c2d6b;color:#58a6ff;border:1px solid #1f6feb; }\
.dlg-badge-behind { background:#3d1f00;color:#d29922;border:1px solid #9e6a03; }\
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
  document.head.appendChild(s);
}

// ─── Dialog core ───────────────────────────────────────────────────────

function createDialog() {
  ensureStyles();
  var overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  var modal = document.createElement('div');
  modal.className = 'dlg-modal';
  document.body.appendChild(overlay);
  document.body.appendChild(modal);

  var reloadNeeded = false;
  function close() {
    overlay.remove();
    modal.remove();
    if (reloadNeeded) location.reload();
  }
  overlay.onclick = close;
  return { modal: modal, close: close, markReload: function () { reloadNeeded = true; } };
}

// ─── Repo selection dialog ──────────────────────────────────────────────

function showRepoSelectionDialog(index) {
  var dlg = createDialog();
  dlg.modal.innerHTML = '<div class="dlg-title">Scanning local repositories\u2026</div>' +
    '<div style="padding:12px 0"><span class="dlg-spinner"></span> Looking for matching clones</div>';

  fetch('/api/repo-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: index, rescan: true })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) throw new Error(data.error);
      renderRepoSelectionDialog(dlg, data, index);
    });
}

function renderRepoSelectionDialog(dlg, data, index) {
  var type = data.isIssue ? 'Issue' : 'PR';
  var html = '<div class="dlg-title">' + esc(type + ' #' + data.number + ' \u2014 ' + data.title) + '</div>';
  if (data.aiStatus) {
    html += '<div class="dlg-subtitle">' + esc(data.aiStatus) + '</div>';
  }

  if (data.clones.length === 0) {
    html += '<div class="dlg-empty">No local clone of ' + esc(data.repo) + ' found.</div>';
  } else {
    html += '<div class="dlg-section">Local clones of ' + esc(data.repo) + '</div>';
    html += '<ul class="dlg-clone-list">';
    for (var i = 0; i < data.clones.length; i++) {
      html += renderCloneRow(data.clones[i], data.branch);
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
  var newCloneBtn = dlg.modal.querySelector('#dlg-new-clone-btn');
  if (newCloneBtn) {
    newCloneBtn.onclick = function () {
      newCloneBtn.style.display = 'none';
      var area = dlg.modal.querySelector('#dlg-new-clone-area');
      area.innerHTML = '<div class="dlg-clone-input-row">' +
        '<input class="dlg-clone-input" id="dlg-clone-path" value="' + esc(data.suggestedClonePath || '') + '" />' +
        '<button class="dlg-btn dlg-btn-primary" data-action="clone" id="dlg-clone-confirm">Clone &amp; chat</button>' +
        '</div>';
      var input = area.querySelector('#dlg-clone-path');
      input.focus();
      input.select();
      area.querySelector('#dlg-clone-confirm').onclick = function () {
        var path = input.value.trim();
        if (!path) return;
        launchAction(dlg, index, 'clone', path);
      };
      input.onkeydown = function (e) {
        if (e.key === 'Enter') {
          var path = input.value.trim();
          if (path) launchAction(dlg, index, 'clone', path);
        }
      };
    };
  }

  // Wire up sync buttons (checkout/pull) — enables sibling chat/IDE buttons on success
  dlg.modal.querySelectorAll('[data-sync]').forEach(function (btn) {
    btn.onclick = function () {
      var action = btn.getAttribute('data-sync');
      var clonePath = btn.getAttribute('data-clone');
      var branchName = btn.getAttribute('data-branch');
      var row = btn.closest('.dlg-clone-row');
      btn.disabled = true;
      btn.textContent = action === 'pull' ? 'Pulling\u2026' : 'Checking out\u2026';
      fetch('/api/repo-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, clonePath: clonePath, branch: branchName })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) throw new Error(d.error);
          dlg.markReload();
          // Re-scan and re-render dialog with fresh state
          return fetch('/api/repo-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: index })
          }).then(function (r) { return r.json(); });
        })
        .then(function (freshData) {
          if (freshData && !freshData.error) {
            renderRepoSelectionDialog(dlg, freshData, index);
          }
        });
    };
  });

  // Wire up all action buttons
  dlg.modal.querySelectorAll('[data-action]').forEach(function (btn) {
    btn.onclick = function () {
      var action = btn.getAttribute('data-action');
      if (action === 'cancel') { dlg.close(); return; }
      var clonePath = btn.getAttribute('data-clone') || '';
      launchAction(dlg, index, action, clonePath);
    };
  });

  // Wire up IDE buttons
  dlg.modal.querySelectorAll('[data-ide]').forEach(function (btn) {
    btn.onclick = function () {
      var cmd = btn.getAttribute('data-ide');
      var clonePath = btn.getAttribute('data-clone');
      btn.disabled = true;
      fetch('/api/open-ide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: cmd, clonePath: clonePath })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) throw new Error(d.error);
          dlg.close();
        });
    };
  });
}

function ideButtons(clonePath, disabled) {
  var ides = (typeof INSTALLED_IDES !== 'undefined') ? INSTALLED_IDES : [];
  var html = '';
  for (var i = 0; i < ides.length; i++) {
    html += '<button class="dlg-btn' + (disabled ? '' : ' dlg-btn-primary') + '" data-ide="' + esc(ides[i].cmd) + '" data-clone="' + esc(clonePath) + '"' + (disabled ? ' disabled' : '') + '>' + esc(ides[i].name) + '</button>';
  }
  return html;
}

function renderCloneRow(clone, branch) {
  var homePath = clone.path.replace(/^\/Users\/[^/]+/, '~');
  var html = '<li class="dlg-clone-row" style="flex-wrap:wrap">';

  // Top line: path, branch, badges
  html += '<span class="dlg-clone-path" title="' + esc(clone.path) + '">' + esc(homePath) + '</span>';
  html += '<span class="dlg-clone-branch">(' + esc(clone.currentBranch) + ')</span>';
  if (clone.onPRBranch) {
    html += '<span class="dlg-badge dlg-badge-branch">on branch</span>';
  }
  if (clone.dirty) {
    html += '<span class="dlg-badge dlg-badge-dirty">dirty: ' + clone.changedFiles.length + ' file' + (clone.changedFiles.length !== 1 ? 's' : '') + '</span>';
  } else {
    html += '<span class="dlg-badge dlg-badge-clean">clean</span>';
  }
  if (clone.behindOrigin) {
    html += '<span class="dlg-badge dlg-badge-behind">behind</span>';
  }

  // Action buttons row
  html += '<div class="dlg-actions" style="width:100%;margin-top:4px">';
  if (clone.dirty && (clone.behindOrigin || !clone.onPRBranch)) {
    html += '<span style="color:#f85149;font-size:10px">dirty \u2014 commit or stash first</span>';
  } else if (clone.behindOrigin || !clone.onPRBranch) {
    var syncLabel = !clone.onPRBranch ? 'Checkout branch' : 'Pull latest';
    var syncAction = !clone.onPRBranch ? 'checkout' : 'pull';
    html += '<button class="dlg-btn dlg-btn-primary" data-sync="' + syncAction + '" data-clone="' + esc(clone.path) + '" data-branch="' + esc(branch || '') + '">' + syncLabel + '</button>';
    html += '<button class="dlg-btn" data-action="chat-here" data-clone="' + esc(clone.path) + '" disabled>Chat in terminal</button>';
    html += ideButtons(clone.path, true);
  } else {
    html += '<button class="dlg-btn dlg-btn-primary" data-action="chat-here" data-clone="' + esc(clone.path) + '">Chat in terminal</button>';
    html += ideButtons(clone.path, false);
  }
  html += '</div>';

  html += '</li>';

  if (clone.dirty) {
    html += '<div class="dlg-dirty-files">' + esc(clone.changedFiles.join('\n')) + '</div>';
  }
  return html;
}

function launchAction(dlg, index, action, clonePath) {
  // Disable all buttons
  dlg.modal.querySelectorAll('button').forEach(function (b) { b.disabled = true; });

  var statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'padding:8px 0;font-size:11px;color:#8b949e;';
  statusDiv.innerHTML = '<span class="dlg-spinner"></span> Launching chat\u2026';
  dlg.modal.querySelector('.dlg-footer').before(statusDiv);

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: index, action: action, clonePath: clonePath })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) throw new Error(d.error);
      dlg.close();
      // Show toast on the chat button
      var btn = document.querySelector('[onclick="showRepoSelectionDialog(' + index + ')"]');
      if (btn && typeof showCopyToast === 'function') {
        showCopyToast(btn, 'opened terminal window');
      }
    });
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
