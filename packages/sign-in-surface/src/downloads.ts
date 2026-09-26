/**
 * The published desktop and mobile builds. One list, read by the admin login
 * and the nessie.works landing, so a renamed release asset changes in one
 * place and both doorways keep pointing at a file that exists.
 */
export const LATEST_RELEASE_DOWNLOAD_BASE =
  'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download'

/**
 * Where the files actually live. Linked once, quietly, under the downloads:
 * somebody verifying a checksum or after an older build needs to be able to get
 * there, and nobody else should be sent there to find a download at all.
 */
export const RELEASES_PAGE =
  'https://github.com/UnlikeOtherAI/Nessie/releases'

export type AppDownload = {
  asset: string
  detail: string
  label: string
  releaseTag?: string
}

export const APP_DOWNLOADS = {
  android: {
    asset: 'Nessie-Android.apk',
    detail: 'GitHub APK',
    label: 'Android',
    releaseTag: 'android-v0.1.2-4',
  },
  linux: { asset: 'Nessie-Linux.AppImage', detail: 'AppImage', label: 'Linux' },
  macAppleSilicon: { asset: 'Nessie-macOS-Apple-Silicon.dmg', detail: 'Apple silicon', label: 'Mac' },
  macIntel: { asset: 'Nessie-macOS-Intel.dmg', detail: 'Intel', label: 'Mac' },
  windows: { asset: 'Nessie-Windows-Setup.exe', detail: '64-bit', label: 'Windows' },
} as const satisfies Record<string, AppDownload>

/**
 * The Nessie Executor menu bar app — a different product from the apps above,
 * and labelled as one. It turns a Mac into an executor: the machine an agent
 * does local work on. Nessie Desktop already carries a copy, so these downloads
 * are for a Mac that runs only the executor and nothing else.
 *
 * The Apple Silicon image carries its own pinned Node. It is Developer ID
 * signed, notarized and stapled, so it needs no Gatekeeper bypass — see
 * docs/running-the-apps/executor-menu-bar-macos.md.
 */
export const EXECUTOR_DOWNLOADS = {
  macAppleSilicon: {
    asset: 'Nessie-Executor-macOS-Apple-Silicon.dmg',
    detail: 'Apple silicon',
    label: 'Mac executor',
  },
} as const satisfies Record<string, AppDownload>

export const downloadUrl = (download: AppDownload): string =>
  download.releaseTag
    ? `${RELEASES_PAGE}/download/${download.releaseTag}/${download.asset}`
    : `${LATEST_RELEASE_DOWNLOAD_BASE}/${download.asset}`
