// The WebView navigation seam. The hosted admin owns all route knowledge;
// these scripts are pure transport onto the two callbacks the admin's
// NativePhoneNavigationBridge publishes:
//   window.__nessieSelectTab(path)  — native tab bar taps (select/reselect)
//   window.__nessieNativeBack()     — Android hardware Back
// __nessieSelectTab falls back to the generic __nessieNavigate (a plain push)
// when the bridge has not mounted yet, so a very early tap still navigates.

export const nativeSelectTabScript = (path: string): string =>
  `window.__nessieSelectTab ? window.__nessieSelectTab(${JSON.stringify(path)}) : (window.__nessieNavigate ? window.__nessieNavigate(${JSON.stringify(path)}) : (window.location.href = ${JSON.stringify(path)}));`

export const nativeBackScript = (): string =>
  'window.__nessieNativeBack && window.__nessieNativeBack();'

// Every Android form factor installs the hardware Back listener — a phone,
// an Android tablet, everything. It used to install only when the iOS-only
// `allowsBackForwardNavigationGestures` WebView prop read false, which on
// Android happened to be `true` past the 600dp tablet breakpoint even though
// that prop does nothing on Android; the two were never related, and the
// coupling meant an Android tablet had no in-app Back at all — the key
// backgrounded the app from any depth. iOS has no hardware Back key and never
// calls this.
export const shouldInstallNativeBackHandler = (isAndroid: boolean): boolean =>
  isAndroid

// Android hardware Back. The admin reports `nessie:back-state` per route; the
// key is consumable only when the LATEST state the page reported says the
// current route has an in-app parent (depth > 0, or an open overlay/nested
// stage once `resolveBack()` backs this). At a tab root the handler returns
// false so the platform default (background/exit) applies.
export const shouldConsumeNativeBack = (hasBackDepth: boolean): boolean =>
  hasBackDepth
