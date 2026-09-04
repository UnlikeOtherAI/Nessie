import type { ReleaseChannel } from '../config'

export const DIRECT_ANDROID_UPDATE_PREFERENCE_KEY = 'nessie.direct-android-update-preference'
export const DIRECT_ANDROID_UPDATE_REMIND_AFTER_MS = 24 * 60 * 60 * 1000

export type DirectAndroidUpdate = {
  url: string
  version: string
  versionCode: number
}

export type DirectAndroidUpdatePreference = {
  remindAfter?: number
  remindVersionCode?: number
  skippedVersionCode?: number
}

type LatestReleaseManifest = {
  android?: {
    url?: unknown
    version?: unknown
    versionCode?: unknown
  }
}

type FetchResponse = {
  json: () => Promise<unknown>
  ok: boolean
}

type DirectAndroidUpdateCheck = {
  channel: ReleaseChannel
  currentVersionCode: number
  fetchRelease: (url: string) => Promise<FetchResponse>
  manifestUrl: string
  now: number
  preference: DirectAndroidUpdatePreference
}

const directReleaseAssetUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/UnlikeOtherAI/Nessie/releases/download/')
      ? url.toString()
      : null
  } catch {
    return null
  }
}

const directAndroidUpdate = (manifest: unknown): DirectAndroidUpdate | null => {
  if (!manifest || typeof manifest !== 'object') return null
  const android = (manifest as LatestReleaseManifest).android
  const versionCode = android?.versionCode
  if (
    !android
    || typeof android.version !== 'string'
    || typeof versionCode !== 'number'
    || !Number.isSafeInteger(versionCode)
  ) {
    return null
  }
  const url = directReleaseAssetUrl(android.url)
  if (!url || versionCode <= 0) return null
  return { url, version: android.version, versionCode }
}

export const findDirectAndroidUpdate = async ({
  channel,
  currentVersionCode,
  fetchRelease,
  manifestUrl,
  now,
  preference,
}: DirectAndroidUpdateCheck): Promise<DirectAndroidUpdate | null> => {
  if (channel !== 'direct' || !Number.isSafeInteger(currentVersionCode) || currentVersionCode < 1) {
    return null
  }

  try {
    const response = await fetchRelease(manifestUrl)
    if (!response.ok) return null
    const update = directAndroidUpdate(await response.json())
    if (!update || update.versionCode <= currentVersionCode) return null
    if (preference.skippedVersionCode === update.versionCode) return null
    if (
      preference.remindVersionCode === update.versionCode
      && typeof preference.remindAfter === 'number'
      && preference.remindAfter > now
    ) {
      return null
    }
    return update
  } catch {
    // An offline start must be silent; the next app start checks again.
    return null
  }
}

export const parseDirectAndroidUpdatePreference = (value: string | null): DirectAndroidUpdatePreference => {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return {}
    const preference = parsed as DirectAndroidUpdatePreference
    return {
      ...(Number.isSafeInteger(preference.remindAfter) ? { remindAfter: preference.remindAfter } : {}),
      ...(Number.isSafeInteger(preference.remindVersionCode)
        ? { remindVersionCode: preference.remindVersionCode }
        : {}),
      ...(Number.isSafeInteger(preference.skippedVersionCode)
        ? { skippedVersionCode: preference.skippedVersionCode }
        : {}),
    }
  } catch {
    return {}
  }
}

export const remindAboutDirectAndroidUpdateLater = (
  versionCode: number,
  now: number,
): DirectAndroidUpdatePreference => ({
  remindAfter: now + DIRECT_ANDROID_UPDATE_REMIND_AFTER_MS,
  remindVersionCode: versionCode,
})

export const skipDirectAndroidUpdate = (versionCode: number): DirectAndroidUpdatePreference => ({
  skippedVersionCode: versionCode,
})
