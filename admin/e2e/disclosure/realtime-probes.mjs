export const installEventProbe = (page, token) => page.evaluate(async (bearer) => {
  const controller = new AbortController()
  window.__disclosureEventProbe = { controller, events: [] }
  const response = await fetch('/api/events/stream', {
    headers: { authorization: `Bearer ${bearer}` },
    signal: controller.signal,
  })
  if (!response.ok) throw new Error(`event stream failed with ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('event stream did not return text/event-stream')
  }
  if (!response.body) throw new Error('event stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  void (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      pending += decoder.decode(next.value, { stream: true })
      let boundary = pending.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const event = /^event: (.+)$/mu.exec(frame)?.[1]
        const data = /^data: (.+)$/mu.exec(frame)?.[1]
        if (event && data) {
          const payload = JSON.parse(data)
          // User SSE relays the normal `{ event, data }` realtime envelope,
          // while durable replay payloads are the event data itself. Normalize
          // both before assertions inspect a message's public preview.
          window.__disclosureEventProbe.events.push({
            data: payload?.event === event && 'data' in payload ? payload.data : payload,
            event,
          })
        }
        boundary = pending.indexOf('\n\n')
      }
    }
  })().catch((error) => {
    if (error.name !== 'AbortError') window.__disclosureEventProbe.error = String(error)
  })
}, token)

export const stopEventProbe = (page) => page.evaluate(() => {
  window.__disclosureEventProbe?.controller.abort()
})

export const installActivityProbe = (page, token, scopes) => page.evaluate(
  ({ bearer, requestedScopes }) => new Promise((resolve, reject) => {
    const key = (scope) => scope.kind === 'agent'
      ? `agent:${scope.agentId}`
      : `channel:${scope.channelId}`
    const includesAll = (granted) => {
      const actual = new Set(granted.map(key))
      return requestedScopes.every((scope) => actual.has(key(scope)))
    }
    const timeout = window.setTimeout(() => {
      reject(new Error('activity socket did not confirm its requested subscriptions'))
    }, 15_000)
    const events = []
    const socket = new WebSocket(
      `ws://localhost:5454/api/activity?token=${encodeURIComponent(bearer)}`,
    )
    window.__disclosureActivityProbe = { events, socket }
    socket.addEventListener('error', () => {
      window.clearTimeout(timeout)
      reject(new Error('activity socket failed to connect'))
    })
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ scopes: requestedScopes, type: 'set_subscriptions' }))
    })
    socket.addEventListener('message', (message) => {
      const frame = JSON.parse(message.data)
      events.push(frame)
      if (frame.type === 'subscribed') {
        window.clearTimeout(timeout)
        if (!includesAll(frame.scopes)) {
          reject(new Error('activity socket denied a requested subscription'))
          return
        }
        resolve()
      }
    })
  }),
  { bearer: token, requestedScopes: scopes },
)

export const setActivitySubscriptions = (page, scopes) => page.evaluate(
  (requestedScopes) => new Promise((resolve, reject) => {
    const probe = window.__disclosureActivityProbe
    if (!probe?.socket) {
      reject(new Error('activity socket is not installed'))
      return
    }
    const key = (scope) => scope.kind === 'agent'
      ? `agent:${scope.agentId}`
      : `channel:${scope.channelId}`
    const includesAll = (granted) => {
      const actual = new Set(granted.map(key))
      return requestedScopes.every((scope) => actual.has(key(scope)))
    }
    const timeout = window.setTimeout(() => {
      probe.socket.removeEventListener('message', onMessage)
      reject(new Error('activity socket did not update its subscriptions'))
    }, 15_000)
    const onMessage = (message) => {
      const frame = JSON.parse(message.data)
      if (frame.type !== 'subscribed') return
      if (!includesAll(frame.scopes)) return
      window.clearTimeout(timeout)
      probe.socket.removeEventListener('message', onMessage)
      resolve()
    }
    probe.socket.addEventListener('message', onMessage)
    probe.socket.send(JSON.stringify({ scopes: requestedScopes, type: 'set_subscriptions' }))
  }),
  scopes,
)

export const reloadWithRealtimeProbes = async (page, token, scopes) => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await installEventProbe(page, token)
  await installActivityProbe(page, token, scopes)
}

export const stopActivityProbe = (page) => page.evaluate(() => {
  window.__disclosureActivityProbe?.socket.close()
})
