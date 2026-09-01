// The native WebView's interactive back/forward swipe and the admin's
// in-page PhoneNavigationViewport back-swipe are mutually exclusive owners of
// the same edge gesture. On phones the admin viewport is the one owner — the
// native gesture would slide the whole WebView over a blank native host (the
// SPA keeps a single history entry, so there is no native snapshot beneath)
// while a competing DOM transition also ran. Tablets keep the native gesture
// because their multi-column layout never mounts the phone viewport.
//
// The gate is purely geometric: both window dimensions at or past the 600dp
// multi-column threshold, matching the admin's tablet breakpoint. It is never
// keyed off the OS — an Android phone is as much a phone as an iPhone, and an
// iPhone in landscape still shows the single-column phone layout.
//
// The result feeds the `allowsBackForwardNavigationGestures` WebView prop,
// which iOS reads and Android silently ignores. Do not read this value to
// decide whether Android's hardware Back listener installs — that is
// `shouldInstallNativeBackHandler` in native-phone-navigation.ts, unconditional
// on Android. The two were wrongly coupled before: this function already
// answers `true` for an Android tablet (past the same 600dp threshold), which
// used to gate the hardware Back listener off entirely even though the prop
// it actually controls does nothing on Android.
export const PHONE_TABLET_BREAKPOINT_DP = 600

export const allowsNativeBackForwardGestures = ({
  widthDp,
  heightDp,
}: {
  widthDp: number
  heightDp: number
}): boolean =>
  widthDp >= PHONE_TABLET_BREAKPOINT_DP && heightDp >= PHONE_TABLET_BREAKPOINT_DP
