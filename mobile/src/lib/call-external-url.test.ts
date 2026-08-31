import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callProviderOrigins,
  isAllowedCallExternalUrl,
  webViewNavigationDisposition,
} from './call-external-url'

const config = { jitsiDomain: 'calls.nessie.example' }

test('allows only exact HTTPS call-provider origins', () => {
  assert.equal(isAllowedCallExternalUrl('https://meet.google.com/abc-defg-hij', config), true)
  assert.equal(isAllowedCallExternalUrl('https://meet.google.com:443/abc-defg-hij', config), true)
  assert.equal(isAllowedCallExternalUrl('https://teams.microsoft.com/l/meetup-join/example', config), true)
  assert.equal(isAllowedCallExternalUrl('https://calls.nessie.example/room', config), true)
  assert.equal(isAllowedCallExternalUrl('https://meet.google.com.evil.test/room', config), false)
  assert.equal(isAllowedCallExternalUrl('http://meet.google.com/room', config), false)
  assert.equal(isAllowedCallExternalUrl('https://meet.google.com:444/room', config), false)
})

test('takes the Jitsi origin only from shell configuration', () => {
  assert.deepEqual(
    [...callProviderOrigins({ jitsiDomain: 'calls.nessie.example:8443' })].sort(),
    ['https://calls.nessie.example:8443', 'https://meet.google.com', 'https://teams.microsoft.com'],
  )
  assert.equal(isAllowedCallExternalUrl('https://calls.nessie.example/room', {
    jitsiDomain: 'calls.nessie.example:8443',
  }), false)
})

test('keeps WebView top-level navigation on the admin origin', () => {
  const navigationConfig = { ...config, adminUrl: 'https://app.nessie.example' }
  assert.equal(webViewNavigationDisposition({
    isTopFrame: true,
    url: 'https://app.nessie.example/channels/channel-1',
  }, navigationConfig), 'allow')
  assert.equal(webViewNavigationDisposition({
    isTopFrame: true,
    url: 'https://meet.google.com/abc-defg-hij',
  }, navigationConfig), 'externalize')
  assert.equal(webViewNavigationDisposition({
    isTopFrame: true,
    url: 'https://outside.example',
  }, navigationConfig), 'block')
  assert.equal(webViewNavigationDisposition({
    isTopFrame: false,
    url: 'https://embedded.example',
  }, navigationConfig), 'allow')
})
