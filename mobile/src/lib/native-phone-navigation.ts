// The phone-only WebView navigation seam. The hosted admin owns all route
// knowledge; these scripts are pure transport onto the two callbacks the
// admin's NativePhoneNavigationBridge publishes:
//   window.__nessieSelectTab(path)  — native tab bar taps (select/reselect)
//   window.__nessieNativeBack()     — Android hardware Back
// __nessieSelectTab falls back to the generic __nessieNavigate (a plain push)
// when the bridge has not mounted yet, so a very early tap still navigates.

export const nativeSelectTabScript = (path: string): string =>
  `window.__nessieSelectTab ? window.__nessieSelectTab(${JSON.stringify(path)}) : (window.__nessieNavigate ? window.__nessieNavigate(${JSON.stringify(path)}) : (window.location.href = ${JSON.stringify(path)}));`

export const nativeBackScript = (): string =>
  'window.__nessieNativeBack && window.__nessieNativeBack();'

// Android hardware Back. The admin reports `nessie:back-state` per route; the
// key is consumable only when the LATEST state the page reported says the
// current route has an in-app parent (depth > 0). At a tab root the handler
// returns false so the platform default (background/exit) applies. iOS has no
// hardware Back key — and tablets keep their own toolbar — so only the phone
// shell installs this listener.
export const shouldConsumeNativeBack = (hasBackDepth: boolean): boolean =>
  hasBackDepth
