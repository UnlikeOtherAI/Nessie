import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIpadNativeChromeTheme,
  getIpadChromeTop,
  getIpadContentTop,
  getIpadTopChromeLayout,
  getIpadWindowedLeadingControlsClearance,
  getIpadWorkspaceMenuAnchorLeft,
  IPAD_WINDOWED_CHROME_TOP,
  isIpadWindowed,
} from './ipad-native-chrome'

const controls = {
  compactControlsWidth: 460,
  fullControlsWidth: 620,
  iconControlsWidth: 198,
  insetLeft: 0,
  insetRight: 0,
  leadingReservedWidth: 0,
  trailingReservedWidth: 54,
}

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
    ...controls,
    hasWorkspace: false,
    screenWidth: 1_024,
  }), { controlsLeft: 202, mode: 'full', workspaceWidth: null })
})

test('moves the full group trailing before compacting it to preserve the workspace switcher', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: true,
    screenWidth: 1_024,
  }), { controlsLeft: 244, mode: 'full', workspaceWidth: 220 })
})

test('uses workspace flexibility before reshuffling the native controls', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: true,
    screenWidth: 780,
  }), { controlsLeft: 94, mode: 'full', workspaceWidth: 70 })
})

test('compacts navigation into overflow only after full controls and flexible workspace cannot fit', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: true,
    screenWidth: 768,
  }), { controlsLeft: 242, mode: 'compact', workspaceWidth: 218 })
})

test('uses section icons before hiding the workspace switcher in a narrow iPad window', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: true,
    screenWidth: 600,
  }), { controlsLeft: 244, mode: 'icons', workspaceWidth: 220 })
})

test('reserves the trailing safe-edge account control before centring or compacting navigation', () => {
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: false,
    screenWidth: 600,
  }), { controlsLeft: 70, mode: 'compact', workspaceWidth: null })
})

test('keeps the workspace switcher clear of Stage Manager window controls', () => {
  assert.equal(isIpadWindowed({
    screenHeight: 1_024,
    screenWidth: 1_366,
    windowHeight: 1_024,
    windowWidth: 1_366,
  }), false)
  assert.equal(isIpadWindowed({
    screenHeight: 1_024,
    screenWidth: 1_366,
    windowHeight: 860,
    windowWidth: 744,
  }), true)
  assert.equal(getIpadWindowedLeadingControlsClearance(false), 0)
  assert.equal(getIpadWindowedLeadingControlsClearance(true), 80)
  assert.deepEqual(getIpadTopChromeLayout({
    ...controls,
    hasWorkspace: true,
    leadingReservedWidth: 80,
    screenWidth: 1_024,
  }), { controlsLeft: 324, mode: 'full', workspaceWidth: 220 })
})

test('places iPad chrome flush below the fullscreen safe area and centred in a window title bar', () => {
  assert.equal(getIpadChromeTop(24), 24)
  assert.equal(getIpadChromeTop(0), IPAD_WINDOWED_CHROME_TOP)
})

test('leaves twelve points between the iPad chrome and web content', () => {
  assert.equal(getIpadContentTop(24), 78)
  assert.equal(getIpadContentTop(IPAD_WINDOWED_CHROME_TOP), 66)
})

test('moves the iPad workspace menu anchor clear of the tablet edge', () => {
  assert.equal(getIpadWorkspaceMenuAnchorLeft(16), 60)
})
