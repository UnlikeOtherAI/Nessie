export type DirectDesktopUpdate = {
  body: string | null
  currentVersion: string
  version: string
}

type DirectDesktopUpdatePreference = {
  remindAfter?: number
  remindVersion?: string
  skippedVersion?: string
}

type DesktopWindow = Window & {
  __nessieDirectUpdater?: unknown
}

const PREFERENCE_KEY = 'nessie.direct-desktop-update-preference'
export const DIRECT_DESKTOP_UPDATE_REMIND_AFTER_MS = 24 * 60 * 60 * 1000

const directDesktopUpdaterEnabled = (): boolean =>
  typeof window !== 'undefined' && (window as DesktopWindow).__nessieDirectUpdater === true

const readPreference = (): DirectDesktopUpdatePreference => {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const preference = parsed as DirectDesktopUpdatePreference
    return {
      ...(typeof preference.remindAfter === 'number' ? { remindAfter: preference.remindAfter } : {}),
      ...(typeof preference.remindVersion === 'string' ? { remindVersion: preference.remindVersion } : {}),
      ...(typeof preference.skippedVersion === 'string' ? { skippedVersion: preference.skippedVersion } : {}),
    }
  } catch {
    return {}
  }
}

const writePreference = (preference: DirectDesktopUpdatePreference): void => {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preference))
  } catch {
    // Private browsing storage failures only mean the next startup asks again.
  }
}

const offerUpdate = (update: DirectDesktopUpdate, preference: DirectDesktopUpdatePreference, now: number): boolean =>
  preference.skippedVersion !== update.version
  && !(
    preference.remindVersion === update.version
    && typeof preference.remindAfter === 'number'
    && preference.remindAfter > now
  )

const invokeDesktopUpdater = async <T>(command: string): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command)
}

export const checkForDirectDesktopUpdate = async (): Promise<DirectDesktopUpdate | null> => {
  if (!directDesktopUpdaterEnabled()) return null
  try {
    const update = await invokeDesktopUpdater<DirectDesktopUpdate | null>('desktop_direct_update_check')
    return update && offerUpdate(update, readPreference(), Date.now()) ? update : null
  } catch {
    // Starts offline and a temporarily unavailable release feed are non-events.
    return null
  }
}

export const installDirectDesktopUpdate = async (): Promise<void> => {
  if (!directDesktopUpdaterEnabled()) return
  await invokeDesktopUpdater<void>('desktop_direct_update_install')
}

export const skipDirectDesktopUpdate = (version: string): void => {
  writePreference({ skippedVersion: version })
}

export const remindAboutDirectDesktopUpdateLater = (version: string, now = Date.now()): void => {
  writePreference({
    remindAfter: now + DIRECT_DESKTOP_UPDATE_REMIND_AFTER_MS,
    remindVersion: version,
  })
}

export const shouldOfferDirectDesktopUpdate = offerUpdate
