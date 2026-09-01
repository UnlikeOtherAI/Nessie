// Shared native and WebView geometry for the translucent iPhone tab bar.
export const IPHONE_TAB_BAR_HEIGHT = 49

// Keep the native controller's host no taller than the actual tab-bar overlay.
// A full-screen TabView placed above the WebView would also intercept content
// touches; this bottom host lets the WebView stay interactive everywhere else.
export const getIphoneTabBarHostHeight = (bottomInset: number): number =>
  IPHONE_TAB_BAR_HEIGHT + (Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0)
