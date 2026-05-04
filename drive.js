// ═══════════════════════════════════════════════════════════════════════════
// ListLens — Google Drive Layer
// Handles: OAuth sign-in, access control, Drive read/write
// Loaded via <script src="drive.js"> BEFORE the main app script
// ═══════════════════════════════════════════════════════════════════════════

const LL_CLIENT_ID = '801481705797-4lr6orueunsbdk5vhhe578bga4ai6lhq.apps.googleusercontent.com';
const LL_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const LL_FOLDER    = 'ListLens';

// Drive file names
const DF_ROWS   = 'listlens_db.json';
const DF_PREDS  = 'listlens_preds.json';
const DF_EVENTS = 'listlens_events.json';
const DF_META   = 'listlens_meta.json';
const DF_USERS  = 'listlens_users.json';

// In-memory cache — all app reads come from here (synchronous)
const _cache = { rows:[], preds:[], events:[], meta:{} };

// Drive state
let _token     = null;
let _folderId  = null;
let _fileIds   = {};
let _userEmail = null;

// ── Auth ──────────────────────────────────────────────────────────────────────
function llSignIn() {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: LL_CLIENT_ID,
    scope: LL_SCOPES,
    callback: function(resp) {
      if (resp.error) { _showAuthError(resp.error); return; }
      _token = resp.access_token;
      fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: 'Bearer ' + _token } })
        .then(r => r.json())
        .then(info => {
          _userEmail = info.email;
          sessionStorage.setItem('ll_user_email', _userEmail);
          _initDrive();
        });
    }
  });
  client.requestAccessToken();
}

function llSignOut() {
  if (_token) google.accounts.oauth2.revoke(_token, function(){});
  _token = null; _userEmail = null;
  sessionStorage.removeItem('ll_user_email');
  _showAuthScreen();
}

// ── Drive init ────────────────────────────────────────────────────────────────
function _initDrive() {
  _showLoading('Loading your data…');
  _findOrCreateFolder(LL_FOLDER)
    .then(function(fid) {
      _folderId = fid;
      // Check user access list
      return _readFile(DF_USERS, []);
    })
    .then(function(users) {
      if (users.length && users.indexOf(_userEmail) === -1) {
        _showAccessDenied(); return;
      }
      // Load all data in parallel
      return Promise.all([
        _readFile(DF_ROWS,   []),
        _readFile(DF_PREDS,  []),
        _readFile(DF_EVENTS, []),
        _readFile(DF_META,   {}),
      ]);
    })
    .then(function(results) {
      if (!results) return; // access denied path
      _cache.rows   = results[0];
      _cache.preds  = results[1];
      _cache.events = results[2];
      _cache.meta   = results[3];
      _showApp();
      // Restore data into the app
      if (_cache.rows.length) {
        build(_cache.rows);
        var fc = document.getElementById('fileChip');
        if (fc) fc.classList.add('loaded');
        var fct = document.getElementById('fileChipText');
        if (fct) fct.textContent = _cache.meta.lastFile || 'Loaded from Drive';
      }
      _updateDriveDot('ok');
    })
    .catch(function(err) {
      console.error('Drive init error:', err);
      _showDriveError(err.message || String(err));
    });
}

// ── Drive helpers ─────────────────────────────────────────────────────────────
function _req(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = 'Bearer ' + _token;
  return fetch(url, opts).then(function(r) {
    if (!r.ok) return r.text().then(function(t){ throw new Error('Drive ' + r.status + ': ' + t); });
    return r.json();
  });
}

function _findOrCreateFolder(name) {
  var q = "mimeType='application/vnd.google-apps.folder' and name='" + name + "' and trashed=false";
  return _req('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)')
    .then(function(res) {
      if (res.files.length) return res.files[0].id;
      return _req('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder' })
      }).then(function(f){ return f.id; });
    });
}

function _findFileId(name) {
  if (_fileIds[name]) return Promise.resolve(_fileIds[name]);
  var q = "name='" + name + "' and '" + _folderId + "' in parents and trashed=false";
  return _req('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)')
    .then(function(res) {
      if (res.files.length) { _fileIds[name] = res.files[0].id; return _fileIds[name]; }
      return null;
    });
}

function _readFile(name, fallback) {
  return _findFileId(name).then(function(id) {
    if (!id) return fallback;
    return fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media',
      { headers: { Authorization: 'Bearer ' + _token } })
      .then(function(r){ return r.ok ? r.json() : fallback; })
      .catch(function(){ return fallback; });
  }).catch(function(){ return fallback; });
}

function _writeFile(name, data) {
  if (!_token || !_folderId) return Promise.resolve();
  var body = JSON.stringify(data);
  return _findFileId(name).then(function(id) {
    if (id) {
      return fetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + _token, 'Content-Type': 'application/json' },
        body: body
      });
    } else {
      var meta = JSON.stringify({ name: name, parents: [_folderId] });
      var form = new FormData();
      form.append('metadata', new Blob([meta], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: 'application/json' }));
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + _token },
        body: form
      }).then(function(r){ return r.json(); })
        .then(function(j){ _fileIds[name] = j.id; });
    }
  }).catch(function(e){ console.warn('Drive write failed:', name, e); });
}

// ── Storage API (called by app code) ─────────────────────────────────────────
function storedRows()  { return _cache.rows;  }
function storedPreds() { return _cache.preds; }
function storedMeta()  { return _cache.meta;  }

function saveRows(rows) {
  _cache.rows = rows;
  _writeFile(DF_ROWS, rows);
}
function savePreds(arr) {
  _cache.preds = arr;
  _writeFile(DF_PREDS, arr);
}
function saveMeta(m) {
  Object.assign(_cache.meta, m);
  _writeFile(DF_META, _cache.meta);
}

// Events: workspace uses these directly
function llGetEvents() { return _cache.events; }
function llSetEvents(arr) {
  _cache.events = arr;
  _writeFile(DF_EVENTS, arr);
}

// ── Admin helpers ─────────────────────────────────────────────────────────────
function llAddUser(email) {
  return _readFile(DF_USERS, []).then(function(users) {
    if (users.indexOf(email) === -1) users.push(email);
    return _writeFile(DF_USERS, users);
  });
}
function llRemoveUser(email) {
  return _readFile(DF_USERS, []).then(function(users) {
    return _writeFile(DF_USERS, users.filter(function(e){ return e !== email; }));
  });
}

// ── UI ────────────────────────────────────────────────────────────────────────
function _showAuthScreen() {
  document.getElementById('ll-auth').style.display    = 'flex';
  document.getElementById('ll-app').style.display     = 'none';
  document.getElementById('ll-loading').style.display = 'none';
}
function _showLoading(msg) {
  document.getElementById('ll-loading-msg').textContent = msg || 'Loading…';
  document.getElementById('ll-auth').style.display    = 'none';
  document.getElementById('ll-app').style.display     = 'none';
  document.getElementById('ll-loading').style.display = 'flex';
}
function _showApp() {
  document.getElementById('ll-auth').style.display    = 'none';
  document.getElementById('ll-loading').style.display = 'none';
  document.getElementById('ll-app').style.display     = 'block';
  var badge = document.getElementById('ll-user-badge');
  if (badge) badge.textContent = _userEmail || '';
  // Update upload page stats now that data is loaded
  if (typeof muRefreshStats === 'function') muRefreshStats();
  if (typeof muRenderLog === 'function') muRenderLog();
  // Signal app is ready (used by tutorial)
  window.dispatchEvent(new Event('ll-app-ready'));
}
function _showAccessDenied() {
  document.getElementById('ll-loading').style.display = 'none';
  document.getElementById('ll-auth').style.display    = 'flex';
  document.getElementById('ll-auth-title').textContent = 'Access denied';
  document.getElementById('ll-auth-sub').textContent  = (_userEmail || 'Your account') + ' is not on the access list. Contact the ListLens admin.';
  document.getElementById('ll-auth-btn').style.display = 'none';
}
function _showDriveError(msg) {
  document.getElementById('ll-loading').style.display = 'none';
  document.getElementById('ll-auth').style.display    = 'flex';
  document.getElementById('ll-auth-title').textContent = 'Could not connect to Drive';
  document.getElementById('ll-auth-sub').textContent  = msg + '. Please try again.';
}
function _showAuthError(msg) {
  document.getElementById('ll-auth-sub').textContent = 'Sign-in failed: ' + msg;
}
function _updateDriveDot(status) {
  var dot = document.getElementById('ll-drive-dot');
  if (dot) dot.style.background = status === 'ok' ? '#00d4aa' : '#f59e0b';
}

// ── Boot: try silent sign-in first, show auth screen only if needed ────────────
document.addEventListener('DOMContentLoaded', function() {
  // Try silent token refresh — works if user has already consented this session
  // Store email in sessionStorage so we can attempt silent refresh on reload
  var savedEmail = sessionStorage.getItem('ll_user_email');
  if (savedEmail) {
    // User was signed in — try silent token refresh
    _trySilentSignIn();
  } else {
    _showAuthScreen();
  }
});

function _trySilentSignIn() {
  _showLoading('Signing in…');
  try {
    var client = google.accounts.oauth2.initTokenClient({
      client_id: LL_CLIENT_ID,
      scope: LL_SCOPES,
      prompt: '',  // empty = silent, no popup
      hint: sessionStorage.getItem('ll_user_email') || '',
      callback: function(resp) {
        if (resp.error) {
          // Silent failed — show auth screen
          _showAuthScreen();
          return;
        }
        _token = resp.access_token;
        fetch('https://www.googleapis.com/oauth2/v3/userinfo',
          { headers: { Authorization: 'Bearer ' + _token } })
          .then(function(r){ return r.json(); })
          .then(function(info) {
            _userEmail = info.email;
            sessionStorage.setItem('ll_user_email', _userEmail);
            _initDrive();
          })
          .catch(function(){ _showAuthScreen(); });
      }
    });
    client.requestAccessToken();
  } catch(e) {
    _showAuthScreen();
  }
}
