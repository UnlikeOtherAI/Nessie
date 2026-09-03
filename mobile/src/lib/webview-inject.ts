import { ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE } from './android-tablet-dock'
import { IPHONE_TAB_BAR_HEIGHT } from './iphone-tab-bar'

// Injected into the admin page. The Android WebView continues beneath its
// floating dock so full-height columns and dividers do not stop at a detached
// native slab; its content reserves the dock through a shared CSS custom
// property. This (1) enables CSS safe-area insets via viewport-fit=cover, (2)
// pads full-screen web surfaces clear of the home indicator, (3) reserves
// interaction space below Android's floating dock, and (4) reports the document
// background so the native view behind the WebView matches during load/overscroll.
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
    var shell = window.__nessieNativeShell;
    var isIosPhone = shell && shell.platform === 'ios' && (
      shell.formFactor === 'phone' || shell.formFactor === 'large-phone-landscape'
    );
    var nativeBottomInset =
      shell && typeof shell.bottomInset === 'number' && isFinite(shell.bottomInset)
        ? Math.max(0, shell.bottomInset)
        : 0;
    // The native frame owns the iPhone status-bar inset: phone tab roots can
    // place their aside below an intermediate DOM wrapper, so a selector-based
    // top inset is not reliable. Keep the surface behind native chrome aligned
    // with the page itself.
    var iosPhoneBackgroundCss = isIosPhone
      ? 'body { background: var(--main); }'
      : '';
    // The WebView reaches under the translucent iPhone tab bar so the bar can
    // blur real page content rather than a separate native slab. Only the
    // page-level scroll region receives end clearance; never shrink the screen
    // or its background above the overlay.
    var iosPhoneTabBarOverlayCss = isIosPhone
      ? [
          ':root { --nessie-native-phone-tabbar-clearance: ' +
            (${IPHONE_TAB_BAR_HEIGHT} + nativeBottomInset) +
            'px; }',
          // Every phone-navigation route has this outer scroll owner. Its
          // spacer covers full-height and horizontal layouts (such as the
          // project board) that deliberately do not own a vertical scroller.
          // A spacer, rather than padding, preserves the route's full-height
          // background beneath the native glass while making its final row
          // reachable above the tab bar.
          '.admin-frame.has-native-phone-tabbar .phone-navigation-page::after {' +
            ' content: "";' +
            ' display: block;' +
            ' height: var(--nessie-native-phone-tabbar-clearance);' +
            ' pointer-events: none;' +
          '}',
          '.admin-frame.has-native-phone-tabbar .nessie-native-phone-tabbar-scroll {' +
            ' padding-bottom: var(--nessie-native-phone-tabbar-clearance);' +
            ' scroll-padding-bottom: var(--nessie-native-phone-tabbar-clearance);' +
          '}',
        ].join('')
      : '';
    var nativeTopbarOwnsSafeArea = shell && shell.platform === 'android';
    var androidNativeFrameCss = nativeTopbarOwnsSafeArea
      ? [
          ':root { --nessie-native-bottom-overlay: ${ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE}px; }',
          '.admin-topbar { height: var(--topbar-h); padding-top: 0; }',
          // The channel composer is part of main's flex flow, so this shared
          // bottom padding keeps the input, controls, and send button clear of
          // the floating dock without adding a disconnected native slab.
          '.admin-shell > aside, .admin-shell > main { padding-bottom: calc(var(--nessie-native-bottom-overlay) + env(safe-area-inset-bottom)); }',
          '[data-testid="channel-content-scroll"] { overflow-x: hidden; }',
          '.admin-message-markdown .admin-message-code-block { overflow-x: auto; overflow-y: hidden; }'
        ].join('')
      : '';
    st.id = styleId;
    st.textContent =
      '.admin-shell > aside, .admin-shell > main {' +
      '  padding-bottom: env(safe-area-inset-bottom);' +
      '}' +
      iosPhoneBackgroundCss +
      iosPhoneTabBarOverlayCss +
      androidNativeFrameCss;
    (document.head || document.documentElement).appendChild(st);
  }

  function bgOf(el) { try { return getComputedStyle(el).backgroundColor } catch (e) { return '' } }
  function transparent(c) {
    if (!c || c === 'transparent') return true;
    var n = c.replace(/[^0-9.,]/g, '').split(',');
    return n.length >= 4 && parseFloat(n[3]) === 0;
  }
  function frameEl() {
    try { return document.querySelector('.admin-frame') } catch (e) { return null }
  }
  // Focus mode is a palette swap the admin scopes to the frame's children
  // (.admin-topbar / .admin-shell), never to <html> or <body>. Reading tokens
  // off documentElement therefore reports the base theme while the page is
  // monochrome, so the native chrome kept its themed accents through focus.
  function focusActive() {
    var f = frameEl();
    return !!(f && f.classList && f.classList.contains('focus-mode'));
  }
  // In focus the native chrome follows whichever focus scope its own context
  // mirrors: the charcoal navigation where the page still draws navigation
  // (iPad, tablet), and otherwise the paper-white work surface, which on a
  // phone is the whole screen the native header and tab bar sit against. Out
  // of focus this stays on documentElement, so the reported palette is
  // byte-for-byte what it was before.
  function themeEl() {
    var f = focusActive() ? frameEl() : null;
    if (f && f.querySelector) {
      var nav = f.querySelector(':scope > .admin-topbar')
        || f.querySelector(':scope > .admin-shell > aside')
        || f.querySelector(':scope > .admin-shell > .resizable-sidebar')
        || f.querySelector(':scope > .admin-shell');
      if (nav) return nav;
    }
    return document.documentElement;
  }
  function pick() {
    // In focus the work surface is the page, so the native backdrop behind the
    // WebView matches it instead of the frame's base-theme body colour.
    if (focusActive()) {
      var f = frameEl();
      var shell = f && f.querySelector ? f.querySelector(':scope > .admin-shell') : null;
      if (shell) { var sc = bgOf(shell); if (!transparent(sc)) return sc; }
    }
    var els = [document.body, document.documentElement, document.getElementById('root')];
    for (var i = 0; i < els.length; i++) {
      if (els[i]) { var c = bgOf(els[i]); if (!transparent(c)) return c; }
    }
    return '';
  }
  var lastBg = '';
  function post() {
    var c = pick();
    if (c && c !== lastBg) {
      lastBg = c;
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'bg', color: c })) } catch (e) {}
    }
  }
  function cssVar(name) {
    try { return getComputedStyle(themeEl()).getPropertyValue(name).trim() } catch (e) { return '' }
  }
  var lastTheme = '';
  function postTheme() {
    var accent = cssVar('--accent');
    var accentStrong = cssVar('--accent-strong');
    var inactive = cssVar('--tx3');
    var surface = cssVar('--panel');
    var text = cssVar('--tx');
    var textMuted = cssVar('--tx2');
    var onAccent = cssVar('--on-accent');
    // Match the uninterrupted surface behind iPad's transparent native tab
    // controls. This is deliberately the page rail rather than a dark top-bar
    // colour, so light themes keep a light phone workspace header too.
    var headerSurface = cssVar('--rail');
    var headerText = cssVar('--tx');
    var scheme = '';
    try { scheme = getComputedStyle(document.documentElement).colorScheme } catch (e) {}
    if (accent || surface || scheme === 'light' || scheme === 'dark') {
      var payload = JSON.stringify({
        type: 'theme', accent: accent, accentStrong: accentStrong, inactive: inactive, scheme: scheme, surface: surface,
        headerSurface: headerSurface, headerText: headerText,
        text: text, textMuted: textMuted, onAccent: onAccent
      });
      // The palette animates over 300ms, so the settle pass below re-reads it
      // many times; only a changed palette reaches the bridge.
      if (payload === lastTheme) return;
      lastTheme = payload;
      try { window.ReactNativeWebView.postMessage(payload) } catch (e) {}
    }
  }
  function syncNativePhoneTabBarScrollRegions() {
    if (!isIosPhone || !window.innerHeight) return;
    var frame = document.querySelector('.admin-frame.has-native-phone-tabbar');
    if (!frame || !frame.querySelectorAll) return;
    var viewportBottom = window.innerHeight;
    // The page shell itself owns the universal end spacer above. Nested,
    // vertical scrollers still need an internal end inset so their final item
    // can scroll above the glass rather than stopping below it.
    var candidates = frame.querySelectorAll('.phone-navigation-page *');
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate.classList || !candidate.getBoundingClientRect) continue;
      var candidateStyle = getComputedStyle(candidate);
      var overflowY = candidateStyle.overflowY;
      var isScroller = overflowY === 'auto' || overflowY === 'scroll';
      var rect = candidate.getBoundingClientRect();
      // Fixed menus own their own placement; only a scroll surface that really
      // reaches the WebView edge can pass beneath the native glass tab bar.
      var reachesNativeTabBar =
        isScroller && candidateStyle.position !== 'fixed' &&
        rect.top < viewportBottom && rect.bottom >= viewportBottom - 1;
      candidate.classList.toggle('nessie-native-phone-tabbar-scroll', reachesNativeTabBar);
    }
  }

  function sync() { syncNativePhoneTabBarScrollRegions(); post(); postTheme(); }
  // Entering or leaving focus interpolates every palette token over 300ms
  // (styles.css registers them with @property). A single read on the class
  // change latches a pre- or mid-animation colour and nothing fires again, so
  // keep sampling until the transition has settled; posts are de-duplicated.
  var settleTimer = null;
  var settleUntil = 0;
  function syncUntilSettled() {
    sync();
    if (!window.setInterval || !window.clearInterval) return;
    settleUntil = Date.now() + 600;
    if (settleTimer) return;
    // Only the colours are re-read while the palette interpolates; rescanning
    // the page's scroll regions on every frame of the transition is wasted work.
    settleTimer = window.setInterval(function () {
      post();
      postTheme();
      if (Date.now() > settleUntil) { window.clearInterval(settleTimer); settleTimer = null; }
    }, 50);
  }
  // The focus class lands on .admin-frame, which neither the documentElement
  // nor the body observer below can see, so a toggle used to reach the native
  // shell as no message at all.
  var frameObserver = null;
  var observedFrame = null;
  function bindFrameObserver() {
    var f = frameEl();
    if (!f || f === observedFrame) return;
    if (frameObserver && frameObserver.disconnect) frameObserver.disconnect();
    observedFrame = f;
    frameObserver = new MutationObserver(syncUntilSettled);
    frameObserver.observe(f, { attributes: true, attributeFilter: ['class'] });
    syncUntilSettled();
  }
  sync();
  bindFrameObserver();

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
    new MutationObserver(function () {
      syncNativePhoneTabBarScrollRegions();
      // The admin frame mounts after this script runs and is replaced on a
      // remount, so pick it up (and re-bind) as the tree changes.
      bindFrameObserver();
    }).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
  window.addEventListener('resize', syncNativePhoneTabBarScrollRegions);
  window.addEventListener('load', sync);
  true;
})();
`

export const DEFAULT_BG = '#1a1d21'

export const parseRgb = (c: string): [number, number, number, number] | null => {
  const hex = c.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex) || /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    const expanded = hex.length <= 4
      ? hex.split('').map((value) => `${value}${value}`).join('')
      : hex
    const alpha = expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1
    return [
      parseInt(expanded.slice(0, 2), 16),
      parseInt(expanded.slice(2, 4), 16),
      parseInt(expanded.slice(4, 6), 16),
      alpha,
    ]
  }
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
