// The mobile app is a thin WebView shell around the Nessie admin web UI,
// mirroring the desktop app. Dev builds load the admin dev server on the Mac's
// LAN address so edits hot-reload on the device; production loads the hosted
// admin. Set EXPO_PUBLIC_ADMIN_URL at build time to override (e.g. a standalone
// Release build that still targets the LAN dev admin, avoiding a Metro
// dependency). Keep this in sync with the desktop tauri.conf.json dev/prod URLs.
const adminUrlOverride = process.env.EXPO_PUBLIC_ADMIN_URL

export const ADMIN_URL =
  adminUrlOverride && adminUrlOverride.length > 0
    ? adminUrlOverride
    : __DEV__
      ? 'http://192.168.1.229:5555'
      : 'https://nessie.unlikeotherai.com'
