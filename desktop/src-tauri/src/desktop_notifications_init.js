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

  const requestPermission = async () => {
    const api = notificationApi()
    if (!api || typeof api.isPermissionGranted !== 'function') return false
    if (await api.isPermissionGranted()) return true
    return (await api.requestPermission()) === 'granted'
  }

  const emitOpen = (path) => {
    if (isInternalPath(path)) {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { path } }))
    }
  }

  const focusDesktopWindow = async () => {
    const currentWindow = window.__TAURI__
      && window.__TAURI__.window
      && window.__TAURI__.window.getCurrentWindow
    try {
      const desktopWindow = currentWindow ? currentWindow() : null
      await desktopWindow?.show?.()
      await desktopWindow?.unminimize?.()
      await desktopWindow?.setFocus?.()
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

  window.__nessieDesktopRequestNotificationPermission = requestPermission
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
