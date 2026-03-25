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

  function close() {
    overlay.remove();
    modal.remove();
  }
  overlay.onclick = close;
  return { modal: modal, close: close };
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

  html += '<div class="dlg-footer">';
  html += '<button class="dlg-btn" data-action="cancel">Cancel</button>';
  html += '</div>';

  dlg.modal.innerHTML = html;

  // Wire up sync buttons (checkout/pull)
  dlg.modal.querySelectorAll('[data-sync]').forEach(function (btn) {
    btn.onclick = function () {
      var action = btn.getAttribute('data-sync');
      var clonePath = btn.getAttribute('data-clone');
      var branchName = btn.getAttribute('data-branch');
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
          updateInlineActions(index, clonePath);
          dlg.close();
        });
    };
  });

  // Wire up cancel button
  dlg.modal.querySelectorAll('[data-action="cancel"]').forEach(function (btn) {
    btn.onclick = function () { dlg.close(); };
  });
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
  } else {
    html += '<span class="dlg-badge dlg-badge-clean">ready</span>';
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
    for (var key in _clonePaths) {
      if (key !== String(index) && _clonePaths[key] === clonePath) {
        var staleEl = document.getElementById('inline-actions-' + key);
        if (staleEl) staleEl.innerHTML = '';
        delete _clonePaths[key];
      }
    }
    _clonePaths[index] = clonePath;
  }
  var inlineEl = document.getElementById('inline-actions-' + index);
  if (!inlineEl) return;
  var parts = clonePath.split('/');
  var homePath = (parts[1] === 'home' || parts[1] === 'Users') ? '~/' + parts.slice(3).join('/') : clonePath;
  var h = '<span class="clone-badge">' + esc(homePath) + '</span>';
  h += '<span class="inline-action" onclick="inlineChat(' + index + ')">chat</span>';
  var ides = (typeof INSTALLED_IDES !== 'undefined') ? INSTALLED_IDES : [];
  for (var k = 0; k < ides.length; k++) {
    var cmd = ides[k].cmd.replaceAll('&','&amp;').replaceAll('"','&quot;');
    h += '<span class="inline-action" onclick="inlineIDE(&quot;' + cmd + '&quot;,' + index + ')">' + ides[k].name.replaceAll('&','&amp;').replaceAll('<','&lt;') + '</span>';
  }
  inlineEl.innerHTML = h;
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
