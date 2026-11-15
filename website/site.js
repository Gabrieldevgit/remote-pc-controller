// Download buttons follow the latest GitHub release (via /api/latest,
// cached by Vercel). Without JavaScript, or if the lookup fails, the buttons
// keep pointing at the GitHub releases page.
(function () {
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  var release = document.getElementById('release');
  if (!release) return;

  function mb(bytes) {
    return Math.round(bytes / (1024 * 1024)) + ' MB';
  }
  function date(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function link(id, asset, label) {
    var a = document.getElementById(id);
    if (!a) return;
    if (asset) {
      a.href = asset.url;
      a.setAttribute('download', '');
      a.classList.remove('hidden');
      if (label) a.textContent = label;
    }
  }
  function text(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  fetch('/api/latest', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (info) {
      if (!info || !info.available) {
        release.textContent = 'The first version is on its way — check back soon, or watch the GitHub releases page.';
        return;
      }
      var when = date(info.publishedAt);
      release.textContent = 'Latest version ' + info.version + (when ? ' · released ' + when : '');
      var a = info.assets || {};
      link('dlSetup', a.windowsSetup || a.windowsPortable, 'Download for Windows');
      if (a.windowsSetup && a.windowsPortable) link('dlPortable', a.windowsPortable, 'Portable .exe');
      link('dlApk', a.android, 'Download the APK');
      var win = a.windowsSetup || a.windowsPortable;
      text('dlWinSize', win ? win.name + ' · ' + mb(win.size) : '');
      text('dlApkSize', a.android ? a.android.name + ' · ' + mb(a.android.size) : '');
    })
    .catch(function () {
      release.textContent = 'See all versions on the GitHub releases page.';
    });
})();
