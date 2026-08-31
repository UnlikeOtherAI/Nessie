import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchExternalUrl } from '../src/lib/open-external-url.js'

test('dispatches external URLs to the desktop opener before considering mobile', async () => {
  const opened: string[] = []
  const posted: string[] = []

  const destination = await dispatchExternalUrl('https://meet.google.com/abc-defg-hij', {
    isDesktop: () => true,
    isMobile: () => true,
    openDesktopUrl: async (url) => { opened.push(url) },
    postMobileMessage: (message) => posted.push(message),
  })

  assert.equal(destination, 'desktop')
  assert.deepEqual(opened, ['https://meet.google.com/abc-defg-hij'])
  assert.deepEqual(posted, [])
})

test('posts the typed native bridge message for the React Native shell', async () => {
  const posted: string[] = []

  const destination = await dispatchExternalUrl('https://teams.microsoft.com/l/meetup-join/example', {
    isDesktop: () => false,
    isMobile: () => true,
    openDesktopUrl: async () => { throw new Error('desktop opener must not run') },
    postMobileMessage: (message) => posted.push(message),
  })

  assert.equal(destination, 'mobile')
  assert.deepEqual(posted.map((message) => JSON.parse(message)), [{
    type: 'nessie:open-external',
    url: 'https://teams.microsoft.com/l/meetup-join/example',
  }])
})

test('leaves ordinary browser navigation to the caller anchor', async () => {
  const destination = await dispatchExternalUrl('https://meet.google.com/abc-defg-hij', {
    isDesktop: () => false,
    isMobile: () => false,
    openDesktopUrl: async () => { throw new Error('desktop opener must not run') },
    postMobileMessage: () => { throw new Error('mobile bridge must not run') },
  })

  assert.equal(destination, 'browser')
})
