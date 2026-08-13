// Native mobile receives the system push notification. Showing this same
// realtime event inside its WebView would duplicate that alert, whereas desktop
// uses the in-app banner as its foreground notification surface.
export const shouldShowInAppMessageBanner = (nativeMobileShell: boolean): boolean =>
  !nativeMobileShell
