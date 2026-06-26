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
  const tag = data.tag || data.collapseId || 'nessie'

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

  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

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
