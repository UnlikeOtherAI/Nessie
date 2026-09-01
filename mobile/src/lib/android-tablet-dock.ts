// The Android dock overlays the WebView. Keep the native geometry and the CSS
// interaction clearance in one place so the chat composer never falls under it.
export const ANDROID_TABLET_TAB_BAR_HEIGHT = 70
export const ANDROID_TABLET_TAB_BAR_BOTTOM_GAP = 8
// Keep the composer comfortably clear of the dock without making it look
// visually detached from the primary navigation.
export const ANDROID_TABLET_TAB_BAR_CONTENT_GAP = 8
export const ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE =
  ANDROID_TABLET_TAB_BAR_HEIGHT
  + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
  + ANDROID_TABLET_TAB_BAR_CONTENT_GAP
