export type DirectDesktopUpdate = {
  body: string | null
  currentVersion: string
  version: string
}

type DesktopWindow = Window & {
  __nessieDirectUpdater?: unknown
}

const directDesktopUpdaterEnabled = (): boolean =>
  typeof window !== 'undefined' && (window as DesktopWindow).__nessieDirectUpdater === true

const invokeDesktopUpdater = async <T>(command: string, args?: Record<string, string>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export const checkForDirectDesktopUpdate = async (): Promise<DirectDesktopUpdate | null> => {
  if (!directDesktopUpdaterEnabled()) return null
  try {
    const update = await invokeDesktopUpdater<DirectDesktopUpdate | null>('desktop_direct_update_check')
    return update
  } catch {
    // Starts offline and a temporarily unavailable release feed are non-events.
    return null
  }
}

export const installDirectDesktopUpdate = async (): Promise<void> => {
  if (!directDesktopUpdaterEnabled()) return
  await invokeDesktopUpdater<void>('desktop_direct_update_install')
}

export const skipDirectDesktopUpdate = async (version: string): Promise<void> => {
  await invokeDesktopUpdater<void>('desktop_direct_update_skip', { version })
}

export const remindAboutDirectDesktopUpdateLater = async (version: string): Promise<void> => {
  await invokeDesktopUpdater<void>('desktop_direct_update_remind', { version })
}
