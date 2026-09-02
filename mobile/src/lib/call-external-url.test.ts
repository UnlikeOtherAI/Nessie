import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callProviderOrigins,
  isAllowedCallExternalUrl,
  openAllowedCallExternalUrl,
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

test('contains a synchronous allowlisted call URL launcher failure', () => {
  let result: boolean | undefined

  assert.doesNotThrow(() => {
    result = openAllowedCallExternalUrl('https://meet.google.com/abc-defg-hij', config, () => {
      throw new Error('native launcher lost its receiver')
    })
  })

  assert.equal(result, true)
})

test('a page-created document never replaces the app', () => {
  // blob: and data: inherit the creating page's origin, so an origin check
  // waves them through — following one swapped the whole SPA for the raw file
  // and lost the navigation state, which read as a crash.
  const navigationConfig = { ...config, adminUrl: 'https://app.nessie.example' }
  for (const url of [
    'blob:https://app.nessie.example/6f0a1f6c-0f2e-4a1b-9c1d-2f3a4b5c6d7e',
    'data:text/markdown;base64,IyBWb2ljZSBjYWxs',
    'filesystem:https://app.nessie.example/temporary/transcript.md',
  ]) {
    assert.equal(
      webViewNavigationDisposition({ isTopFrame: true, url }, navigationConfig),
      'block',
      url,
    )
  }
})

test('an embedded frame is still left alone', () => {
  // The guard governs top-level navigation only; blocking sub-frames would
  // break ordinary embedded content.
  assert.equal(
    webViewNavigationDisposition(
      { isTopFrame: false, url: 'blob:https://app.nessie.example/inner' },
      { ...config, adminUrl: 'https://app.nessie.example' },
    ),
    'allow',
  )
})
