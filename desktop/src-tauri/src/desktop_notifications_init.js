(function () {
  const TOKEN_KEY = 'nessie.admin.token'
  const BASE_URL_KEYS = ['nessie.admin.apiBaseUrl', 'nessie.api.baseUrl']
  const RECONNECT_DELAY_MS = 2000
  const NOTIFIABLE_EVENTS = [
    'message.new',
    'message.mention',
    'mention.new',
    'mention.created',
    'approval.needed',
    'approval.resolved',
    'approval.created',
  ]

  const state = {
    apiBaseUrl: null,
    connectionKey: '',
    lastEventId: '',
    notificationRoutes: new Map(),
    stopStream: null,
  }

  const readStoredToken = () => {
    try {
      return window.localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  }

  const normalizeBaseUrl = (value) => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim().replace(/\/$/, '')
    return trimmed.length > 0 ? trimmed : ''
  }

  const readConfiguredApiBaseUrl = () => {
    const globals = [
      window.__NESSIE_DESKTOP_API_BASE_URL__,
      window.__NESSIE_API_BASE_URL__,
    ]
    for (const value of globals) {
      const normalized = normalizeBaseUrl(value)
      if (normalized !== null) return normalized
    }

    for (const key of BASE_URL_KEYS) {
      try {
        const normalized = normalizeBaseUrl(window.localStorage.getItem(key))
        if (normalized !== null) return normalized
      } catch {
        // Ignore storage access errors; the admin app remains the source of truth.
      }
    }

    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return ''
    }

    return null
  }

  const setObservedApiBaseUrl = (nextBaseUrl) => {
    const normalized = normalizeBaseUrl(nextBaseUrl)
    if (normalized === null || normalized === state.apiBaseUrl) return
    state.apiBaseUrl = normalized
    refreshConnection()
  }

  const resolveRequestUrl = (input) => {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        return new URL(String(input), window.location.href)
      }
      if (input instanceof Request) {
        return new URL(input.url, window.location.href)
      }
    } catch {
      return null
    }
    return null
  }

  const rememberApiBaseFromFetch = (input) => {
    const url = resolveRequestUrl(input)
    if (!url || !url.pathname.startsWith('/api/')) return
    setObservedApiBaseUrl(url.origin === window.location.origin ? '' : url.origin)
  }

  const patchFetchForApiBaseDiscovery = () => {
    if (window.__nessieDesktopNotificationsFetchPatched) return
    window.__nessieDesktopNotificationsFetchPatched = true
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      rememberApiBaseFromFetch(input)
      return originalFetch(input, init)
    }
  }

  const apiUrl = (baseUrl, path) => {
    if (!baseUrl) return path
    return `${baseUrl}${path}`
  }

  const withTokenQuery = (url, token) => {
    const parsed = new URL(url, window.location.href)
    parsed.searchParams.set('token', token)
    return parsed.toString()
  }

  const currentChannelId = () => {
    const match = window.location.pathname.match(/^\/channels(?:\/([^/]+))?$/)
    return match ? match[1] : undefined
  }

  const stringFrom = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return undefined
  }

  const nested = (value, path) => {
    let current = value
    for (const key of path) {
      if (!current || typeof current !== 'object') return undefined
      current = current[key]
    }
    return current
  }

  const unwrapEventData = (payload) => {
    if (!payload || typeof payload !== 'object') return {}
    const data = payload.data
    return data && typeof data === 'object' ? data : payload
  }

  const channelIdFor = (payload, data) =>
    stringFrom(
      data.channelId,
      payload.channelId,
      nested(data, ['channel', 'id']),
      nested(payload, ['channel', 'id']),
    )

  const notificationRouteFor = (eventName, payload, data) => {
    const channelId = channelIdFor(payload, data)
    if (channelId) return `/channels/${encodeURIComponent(channelId)}`
    if (eventName.startsWith('approval.')) return '/approvals'
    return '/channels'
  }

  const shouldNotify = (eventName, payload, data) => {
    if (
      eventName === 'message.new' ||
      eventName.includes('mention') ||
      eventName.startsWith('approval.')
    ) {
      const channelId = channelIdFor(payload, data)
      return !(
        channelId &&
        document.hasFocus() &&
        document.visibilityState === 'visible' &&
        currentChannelId() === channelId
      )
    }

    return false
  }

  const truncate = (value, maxLength) => {
    if (!value) return undefined
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
  }

  const notificationFor = (eventName, payload) => {
    const data = unwrapEventData(payload)
    const route = notificationRouteFor(eventName, payload, data)
    const channelLabel = stringFrom(
      data.channelName,
      data.channelLabel,
      nested(data, ['channel', 'label']),
      nested(data, ['channel', 'name']),
      channelIdFor(payload, data),
    )
    const sender = stringFrom(
      data.authorName,
      data.senderName,
      data.userName,
      data.agentName,
      data.role,
    )
    const snippet = truncate(
      stringFrom(data.contentSnippet, data.contentPreview, data.snippet, data.content, data.reason),
      180,
    )

    if (!shouldNotify(eventName, payload, data)) return null

    if (eventName.startsWith('approval.')) {
      return {
        route,
        title: eventName === 'approval.resolved' ? 'Approval updated' : 'Approval needed',
        body: truncate(stringFrom(data.action, data.reason, data.outcome), 180),
      }
    }

    const title = channelLabel
      ? `${sender ? `${sender} in ` : ''}#${channelLabel}`
      : sender ?? 'New Nessie message'
    return {
      route,
      title,
      body: sender && snippet && !title.startsWith(sender) ? `${sender}: ${snippet}` : snippet,
    }
  }

  const ensureNotificationPermission = async () => {
    const api = window.__TAURI__ && window.__TAURI__.notification
    if (api && typeof api.isPermissionGranted === 'function') {
      if (await api.isPermissionGranted()) return true
      return (await api.requestPermission()) === 'granted'
    }

    if (!('Notification' in window)) return false
    if (window.Notification.permission === 'granted') return true
    if (window.Notification.permission === 'denied') return false
    return (await window.Notification.requestPermission()) === 'granted'
  }

  const focusAndNavigate = async (route) => {
    const currentWindow =
      window.__TAURI__ &&
      window.__TAURI__.window &&
      window.__TAURI__.window.getCurrentWindow
    try {
      const tauriWindow = currentWindow ? currentWindow() : null
      await tauriWindow?.show?.()
      await tauriWindow?.unminimize?.()
      await tauriWindow?.setFocus?.()
    } catch {
      // Focusing is best-effort; route navigation should still happen.
    }

    if (window.location.pathname === route) return
    window.history.pushState({}, '', route)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const registerNotificationClickHandler = () => {
    const api = window.__TAURI__ && window.__TAURI__.notification
    if (!api || typeof api.onAction !== 'function' || window.__nessieDesktopNotificationClicks) {
      return
    }

    window.__nessieDesktopNotificationClicks = true
    void api.onAction((event) => {
      const notification = event && event.notification ? event.notification : event
      const route = stringFrom(
        nested(notification, ['extra', 'route']),
        notification && state.notificationRoutes.get(notification.id),
      )
      if (route) void focusAndNavigate(route)
    }).catch(() => undefined)
  }

  const sendNativeNotification = async (notification) => {
    if (!(await ensureNotificationPermission())) return

    const id = Math.floor(Math.random() * 2147483647)
    state.notificationRoutes.set(id, notification.route)
    const payload = {
      id,
      title: notification.title,
      body: notification.body,
      autoCancel: true,
      extra: { route: notification.route },
    }

    const api = window.__TAURI__ && window.__TAURI__.notification
    if (api && typeof api.sendNotification === 'function') {
      api.sendNotification(payload)
      return
    }

    if ('Notification' in window) {
      const browserNotification = new window.Notification(payload.title, payload)
      browserNotification.onclick = () => void focusAndNavigate(notification.route)
    }
  }

  const handleEvent = (eventName, rawData, eventId) => {
    if (eventId) state.lastEventId = eventId
    let payload
    try {
      payload = JSON.parse(rawData)
    } catch {
      return
    }

    const resolvedEventName = stringFrom(payload.event, eventName) ?? eventName
    const notification = notificationFor(resolvedEventName, payload)
    if (notification) void sendNativeNotification(notification)
  }

  const parseSseFrame = (frame) => {
    const parsed = { event: 'message', data: '', id: '' }
    const dataLines = []
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const separatorIndex = line.indexOf(':')
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
      const value = separatorIndex === -1
        ? ''
        : line.slice(separatorIndex + 1).replace(/^ /, '')
      if (field === 'event') parsed.event = value
      if (field === 'id') parsed.id = value
      if (field === 'data') dataLines.push(value)
    }
    parsed.data = dataLines.join('\n')
    return parsed
  }

  const connectFetchStream = (baseUrl, token) => {
    let stopped = false
    let controller = null

    const loop = async () => {
      while (!stopped) {
        controller = new AbortController()
        const headers = { authorization: `Bearer ${token}` }
        if (state.lastEventId) headers['Last-Event-ID'] = state.lastEventId

        try {
          const response = await fetch(apiUrl(baseUrl, '/api/events/stream'), {
            headers,
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            throw new Error(`events stream failed: ${response.status}`)
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!stopped) {
            const result = await reader.read()
            if (result.done) break
            buffer += decoder.decode(result.value, { stream: true })
            const frames = buffer.split(/\r?\n\r?\n/)
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              const parsed = parseSseFrame(frame)
              if (parsed.data) handleEvent(parsed.event, parsed.data, parsed.id)
            }
          }
        } catch {
          // Connection lost; the loop below reconnects while the session is current.
        }

        if (!stopped) {
          await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_DELAY_MS))
        }
      }
    }

    void loop()
    return () => {
      stopped = true
      controller?.abort()
    }
  }

  const connectStream = (baseUrl, token) => {
    if (!('EventSource' in window)) return connectFetchStream(baseUrl, token)

    let opened = false
    let switchedToFetch = false
    let stopped = false
    let fetchStop = null
    const source = new EventSource(withTokenQuery(apiUrl(baseUrl, '/api/events/stream'), token))

    source.onopen = () => {
      opened = true
    }

    source.onerror = () => {
      if (stopped || opened || switchedToFetch) return
      switchedToFetch = true
      source.close()
      fetchStop = connectFetchStream(baseUrl, token)
    }

    for (const eventName of NOTIFIABLE_EVENTS) {
      source.addEventListener(eventName, (event) => {
        handleEvent(eventName, event.data, event.lastEventId)
      })
    }

    source.onmessage = (event) => {
      handleEvent('message', event.data, event.lastEventId)
    }

    return () => {
      stopped = true
      source.close()
      fetchStop?.()
    }
  }

  function refreshConnection() {
    registerNotificationClickHandler()
    const token = readStoredToken()
    const configuredBaseUrl = readConfiguredApiBaseUrl()
    const apiBaseUrl = state.apiBaseUrl ?? configuredBaseUrl
    const nextKey = token && apiBaseUrl !== null ? `${apiBaseUrl}\n${token}` : ''

    if (nextKey === state.connectionKey) return
    state.stopStream?.()
    state.stopStream = null
    state.connectionKey = nextKey
    state.lastEventId = ''

    if (token && apiBaseUrl !== null) {
      state.stopStream = connectStream(apiBaseUrl, token)
    }
  }

  patchFetchForApiBaseDiscovery()
  registerNotificationClickHandler()
  refreshConnection()
  window.addEventListener('storage', refreshConnection)
  window.addEventListener('visibilitychange', refreshConnection)
  window.setInterval(refreshConnection, 1000)
})()
