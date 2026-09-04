/**
 * The published desktop and mobile builds. One list, read by the admin login
 * and the nessie.works landing, so a renamed release asset changes in one
 * place and both doorways keep pointing at a file that exists.
 */
export const LATEST_RELEASE_DOWNLOAD_BASE =
  'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download'

export type AppDownload = {
  asset: string
  detail: string
  label: string
}

export const APP_DOWNLOADS = {
  android: { asset: 'Nessie-Android.apk', detail: 'APK', label: 'Android' },
  linux: { asset: 'Nessie-Linux.AppImage', detail: 'AppImage', label: 'Linux' },
  macAppleSilicon: { asset: 'Nessie-macOS-Apple-Silicon.dmg', detail: 'Apple silicon', label: 'Mac' },
  macIntel: { asset: 'Nessie-macOS-Intel.dmg', detail: 'Intel', label: 'Mac' },
  windows: { asset: 'Nessie-Windows-Setup.exe', detail: '64-bit', label: 'Windows' },
} as const satisfies Record<string, AppDownload>

export const downloadUrl = (download: AppDownload): string =>
  `${LATEST_RELEASE_DOWNLOAD_BASE}/${download.asset}`
