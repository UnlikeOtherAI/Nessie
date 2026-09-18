import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE,
  androidDockContentClearance,
} from './android-tablet-dock'

test('the Android dock clearance carries the safe area the WebView cannot be trusted for', () => {
  // The frame reaches the bottom of the window, so the page's whole bottom
  // clearance is this one number: the dock, its gaps, and whatever the system
  // bars are taking while they are showing.
  assert.equal(
    androidDockContentClearance({ bottomInset: 28, dockShowing: true }),
    ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE + 28,
  )
  assert.equal(
    androidDockContentClearance({ bottomInset: 0, dockShowing: true }),
    ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE,
  )
})

test('a route that draws no dock reserves nothing for one', () => {
  assert.equal(androidDockContentClearance({ bottomInset: 28, dockShowing: false }), 0)
})

test('a missing or negative inset never shortens the dock clearance', () => {
  assert.equal(
    androidDockContentClearance({ bottomInset: -12, dockShowing: true }),
    ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE,
  )
  assert.equal(
    androidDockContentClearance({ bottomInset: Number.NaN, dockShowing: true }),
    ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE,
  )
})
