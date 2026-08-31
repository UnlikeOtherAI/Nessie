// The mobile app is a thin WebView shell around the Nessie admin web UI,
// mirroring the desktop app. Dev builds load the admin dev server on the Mac's
// LAN address so edits hot-reload on the device; production loads the hosted
// admin. Set EXPO_PUBLIC_ADMIN_URL at build time to override (e.g. a standalone
// Release build that still targets the LAN dev admin, avoiding a Metro
// dependency). Keep this in sync with the desktop tauri.conf.json dev/prod URLs.
const adminUrlOverride = process.env.EXPO_PUBLIC_ADMIN_URL
const jitsiDomainOverride = process.env.EXPO_PUBLIC_JITSI_DOMAIN

export const ADMIN_URL =
  adminUrlOverride && adminUrlOverride.length > 0
    ? adminUrlOverride
    : __DEV__
      ? 'http://192.168.1.229:5455'
      : 'https://app.nessie.works'

// This is build-time shell configuration, not data accepted from the hosted
// admin. Keep it aligned with NESSIE_JITSI_DOMAIN when a team self-hosts Jitsi.
export const CALL_JITSI_DOMAIN =
  jitsiDomainOverride && jitsiDomainOverride.length > 0
    ? jitsiDomainOverride
    : 'meet.jit.si'
