// The native WebView's interactive back/forward swipe is off on every form
// factor (docs/navigation/overview.md §10, plan §7). It is a WebView-wide switch that
// cannot be scoped to one column, and two owners of one edge gesture is the
// exact failure phones already fixed: it would slide the whole document over
// a blank native host (the SPA keeps a single history entry, so nothing is
// beneath) while a competing DOM transition ran. On phones the admin's stack
// owns the edge swipe; on iPad and large-phone landscape every screen header
// carries a Back and the iPad toolbar walks history on the one ledger, which
// is why the switch could only be thrown once ScreenHeader had landed.
//
// Android's hardware Back listener is a separate decision —
// `shouldInstallNativeBackHandler` in native-phone-navigation.ts — and never
// reads this value.
export const NATIVE_BACK_FORWARD_GESTURES = false
