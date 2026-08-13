import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  getIpadContentTop,
  getIpadTopChromeLayout,
  IPAD_WINDOWED_CHROME_TOP,
} from './ipad-native-chrome'

test('builds iPad top chrome from the active theme colours', () => {
  const theme = createIpadNativeChromeTheme({
    activeTintColor: '#2563eb',
    dark: false,
    inactiveTintColor: '#64748b',
    surfaceColor: '#ffffff',
  })

  assert.equal(theme.backgroundColor, '#ffffffe0')
  assert.equal(theme.activeBackgroundColor, '#2563eb24')
  assert.equal(theme.pressedBackgroundColor, '#2563eb33')
  assert.equal(theme.activeTintColor, '#2563eb')
  assert.equal(theme.inactiveTintColor, '#64748b')
})

test('centres the complete iPad chrome group when no workspace is present', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    compactControlsWidth: 460,
    fullControlsWidth: 620,
    hasWorkspace: false,
    insetLeft: 0,
    insetRight: 0,
    screenWidth: 1_024,
  }), { controlsLeft: 202, mode: 'full', workspaceWidth: null })
})

test('moves the full group trailing before compacting it to preserve the workspace switcher', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    compactControlsWidth: 460,
    fullControlsWidth: 620,
    hasWorkspace: true,
    insetLeft: 0,
    insetRight: 0,
    screenWidth: 1_024,
  }), { controlsLeft: 244, mode: 'full', workspaceWidth: 220 })
})

test('compacts navigation into overflow only after the full group cannot fit', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    compactControlsWidth: 460,
    fullControlsWidth: 620,
    hasWorkspace: true,
    insetLeft: 0,
    insetRight: 0,
    screenWidth: 768,
  }), { controlsLeft: 244, mode: 'compact', workspaceWidth: 220 })
})

test('shrinks and finally hides the workspace switcher before overlap in a narrow iPad window', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    compactControlsWidth: 460,
    fullControlsWidth: 620,
    hasWorkspace: true,
    insetLeft: 0,
    insetRight: 0,
    screenWidth: 700,
  }), { controlsLeft: 120, mode: 'compact', workspaceWidth: 96 })
  assert.deepEqual(getIpadTopChromeLayout({
    compactControlsWidth: 460,
    fullControlsWidth: 620,
    hasWorkspace: true,
    insetLeft: 0,
    insetRight: 0,
    screenWidth: 600,
  }), { controlsLeft: 70, mode: 'compact', workspaceWidth: null })
})

test('places iPad chrome flush below the fullscreen safe area and centred in a window title bar', () => {
  assert.equal(getIpadChromeTop(24), 24)
  assert.equal(getIpadChromeTop(0), IPAD_WINDOWED_CHROME_TOP)
})

test('leaves twelve points between the iPad chrome and web content', () => {
  assert.equal(getIpadContentTop(24), 78)
  assert.equal(getIpadContentTop(IPAD_WINDOWED_CHROME_TOP), 66)
})
