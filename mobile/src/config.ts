// The mobile app is a thin WebView shell around the Nessie admin web UI,
// mirroring the desktop app. Dev builds load the admin dev server on the Mac's
// LAN address so edits hot-reload on the device; production loads the hosted
// admin. Keep this in sync with the desktop tauri.conf.json dev/prod URLs.
export const ADMIN_URL = __DEV__
  ? 'http://192.168.1.229:5555'
  : 'https://nessie.unlikeotherai.com'
