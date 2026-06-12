// Injected into the admin page. The WebView fills the area above the native tab
// bar; the admin's full-height columns run edge to edge. This (1) enables CSS
// safe-area insets via viewport-fit=cover, (2) pads the column *content* up from
// the home indicator (the global top bar already clears the status bar/notch via
// its own safe-area-inset-top), and (3) reports the document background so the
// native view behind the WebView matches during load/overscroll.
export const INJECTED = `
(function () {
  var vp = document.querySelector('meta[name=viewport]');
  if (vp && vp.content.indexOf('viewport-fit') === -1) { vp.content += ', viewport-fit=cover'; }
  else if (!vp) {
    vp = document.createElement('meta');
    vp.name = 'viewport';
    vp.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    (document.head || document.documentElement).appendChild(vp);
  }

  var styleId = 'nessie-mobile-safe-area';
  if (!document.getElementById(styleId)) {
    var st = document.createElement('style');
    st.id = styleId;
    st.textContent =
      '.admin-shell > aside, .admin-shell > main {' +
      '  padding-bottom: env(safe-area-inset-bottom);' +
      '}';
    (document.head || document.documentElement).appendChild(st);
  }

  function bgOf(el) { try { return getComputedStyle(el).backgroundColor } catch (e) { return '' } }
  function transparent(c) {
    if (!c || c === 'transparent') return true;
    var n = c.replace(/[^0-9.,]/g, '').split(',');
    return n.length >= 4 && parseFloat(n[3]) === 0;
  }
  function pick() {
    var els = [document.body, document.documentElement, document.getElementById('root')];
    for (var i = 0; i < els.length; i++) {
      if (els[i]) { var c = bgOf(els[i]); if (!transparent(c)) return c; }
    }
    return '';
  }
  function post() {
    var c = pick();
    if (c) { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'bg', color: c })) } catch (e) {} }
  }
  function cssVar(name) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() } catch (e) { return '' }
  }
  function postTheme() {
    var accent = cssVar('--accent');
    var inactive = cssVar('--tx3');
    if (accent) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'theme', accent: accent, inactive: inactive }))
      } catch (e) {}
    }
  }
  function sync() { post(); postTheme(); }
  sync();

  function installBuildFreshnessCheck() {
    if (window.__nessieBuildFreshnessInstalled) return;
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

    var intervalMs = 5 * 60 * 1000;
    var reloadMarker = 'nessie.buildFreshnessReloaded';
    var selector = 'script[src], link[rel="stylesheet"][href]';
    var currentSignature = assetSignature(document, window.location.href);
    var checking = false;
    if (!currentSignature) return;
    window.__nessieBuildFreshnessInstalled = true;

    function absolutePath(url, baseUrl) {
      try {
        var parsed = new URL(url, baseUrl);
        return parsed.origin === window.location.origin ? parsed.pathname + parsed.search : null;
      } catch (e) {
        return null;
      }
    }
    function assetSignature(documentRoot, baseUrl) {
      var nodes = Array.prototype.slice.call(documentRoot.querySelectorAll(selector));
      var seen = {};
      return nodes
        .map(function (element) {
          return element.tagName === 'SCRIPT'
            ? absolutePath(element.src, baseUrl)
            : absolutePath(element.href, baseUrl);
        })
        .filter(function (asset) {
          if (!asset || seen[asset]) return false;
          seen[asset] = true;
          return true;
        })
        .sort()
        .join('|');
    }
    function checkForFreshBuild() {
      if (checking) return;
      checking = true;
      fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } })
        .then(function (response) { return response.ok ? response.text() : ''; })
        .then(function (html) {
          if (!html) return;
          var parsed = new DOMParser().parseFromString(html, 'text/html');
          var latestSignature = assetSignature(parsed, window.location.origin);
          if (!latestSignature || latestSignature === currentSignature) {
            sessionStorage.removeItem(reloadMarker);
            return;
          }
          if (sessionStorage.getItem(reloadMarker) === latestSignature) return;
          sessionStorage.setItem(reloadMarker, latestSignature);
          window.location.reload();
        })
        .catch(function () {})
        .then(function () { checking = false; });
    }
    function checkWhenVisible() {
      if (document.visibilityState === 'visible') checkForFreshBuild();
    }

    window.addEventListener('focus', checkWhenVisible);
    window.addEventListener('pageshow', checkWhenVisible);
    document.addEventListener('visibilitychange', checkWhenVisible);
    window.setInterval(checkWhenVisible, intervalMs);
  }

  installBuildFreshnessCheck();
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'class', 'style'],
  });
  if (document.body) {
    new MutationObserver(post).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('load', sync);
  true;
})();
`

export const DEFAULT_BG = '#1a1d21'

export const parseRgb = (c: string): [number, number, number, number] | null => {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(',').map((s) => parseFloat(s.trim()))
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}

export const isDark = (c: string): boolean => {
  const rgb = parseRgb(c)
  if (!rgb) return true
  const [r, g, b] = rgb
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}
