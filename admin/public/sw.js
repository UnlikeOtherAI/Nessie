/* Nessie admin service worker — web push delivery + notification clicks. */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  if (!event.data) {
    return
  }

  let payload = {}
  try {
    payload = event.data.json()
  } catch (error) {
    payload = { title: 'Nessie', body: event.data.text() }
  }

  const data = payload.data || {}
  // Coalesce per channel so a new message replaces the prior one for the same
  // channel (not all notifications). The worker sends collapseId at the top
  // level of the payload and channelId inside data — prefer those over a global
  // tag, which would make every notification overwrite the last.
  const tag = data.tag || data.channelId || payload.collapseId || 'nessie'

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Nessie', {
      body: payload.body,
      icon: '/icon-1024.png',
      badge: '/icon-1024.png',
      tag,
      data,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Resolve to an absolute URL so it matches an open client's absolute `url`
  // (the worker sends a relative path like "/channels/abc"); otherwise the
  // comparison never matches and a duplicate tab is always opened.
  const relative = (event.notification.data && event.notification.data.url) || '/'
  const targetUrl = new URL(relative, self.location.origin).href

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus()
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl)
        }
        return undefined
      }),
  )
})
