(function () {
  const OPEN_EVENT = 'nessie:desktop-notification-open'
  const notificationRoutes = new Map()

  const stringFrom = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }

  const isInternalPath = (value) =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')

  const notificationApi = () => window.__TAURI__ && window.__TAURI__.notification

  const desktopWindow = () => window.__TAURI__
    && window.__TAURI__.window
    && window.__TAURI__.window.getCurrentWindow
    ? window.__TAURI__.window.getCurrentWindow()
    : null

  const requestPermission = async () => {
    const api = notificationApi()
    if (!api || typeof api.isPermissionGranted !== 'function') return false
    if (await api.isPermissionGranted()) return true
    return (await api.requestPermission()) === 'granted'
  }

  // The path is retained on the window before the event fires: a click on
  // a quit app arrives before the SPA has subscribed, and the root redirect
  // replays it (docs/navigation/overview.md §8), exactly as the native shell's
  // pending push path is replayed. The SPA clears it once consumed.
  const emitOpen = (path) => {
    if (isInternalPath(path)) {
      window.__nessieDesktopPendingPath = path
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { path } }))
    }
  }

  const focusDesktopWindow = async () => {
    try {
      const currentWindow = desktopWindow()
      await currentWindow?.show?.()
      await currentWindow?.unminimize?.()
      await currentWindow?.setFocus?.()
    } catch {
      // The route is still actionable if window focus is unavailable.
    }
  }

  const registerNotificationClickHandler = () => {
    const api = notificationApi()
    if (!api || typeof api.onAction !== 'function' || window.__nessieDesktopNotificationClicks) {
      return
    }

    window.__nessieDesktopNotificationClicks = true
    void api.onAction((event) => {
      const notification = event && event.notification ? event.notification : event
      const path = stringFrom(
        notification && notification.extra && notification.extra.path,
        notification && notificationRoutes.get(notification.id),
      )
      void focusDesktopWindow().finally(() => emitOpen(path))
    }).catch(() => undefined)
  }

  const invoke = () => window.__TAURI__
    && window.__TAURI__.core
    && typeof window.__TAURI__.core.invoke === 'function'
    ? window.__TAURI__.core.invoke
    : null

  window.__nessieDesktopRequestNotificationPermission = requestPermission
  window.__nessieDesktopSetBadgeCount = async (input) => {
    const parsed = Number(input)
    const count = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
    // The shell command knows what this platform can actually show — a Dock
    // badge, a taskbar overlay icon, or nothing at all. The window API is the
    // fallback for a shell that predates it.
    const invokeCommand = invoke()
    if (invokeCommand) {
      try {
        return (await invokeCommand('desktop_set_badge', { count })) === true
      } catch {
        // An older shell has no such command; try the window API below.
      }
    }
    const currentWindow = desktopWindow()
    if (!currentWindow || typeof currentWindow.setBadgeCount !== 'function') return false
    try {
      await currentWindow.setBadgeCount(count)
      return true
    } catch {
      return false
    }
  }
  window.__nessieDesktopNotify = async (input) => {
    if (!input || !isInternalPath(input.path)) return false
    const api = notificationApi()
    if (!api || typeof api.sendNotification !== 'function' || !(await requestPermission())) {
      return false
    }

    const id = Math.floor(Math.random() * 2147483647)
    notificationRoutes.set(id, input.path)
    try {
      await api.sendNotification({
        autoCancel: true,
        body: stringFrom(input.body),
        extra: { path: input.path },
        id,
        title: stringFrom(input.title) ?? 'Nessie',
      })
      return true
    } catch {
      notificationRoutes.delete(id)
      return false
    }
  }

  registerNotificationClickHandler()
})()
