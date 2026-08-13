import assert from 'node:assert/strict'
import test from 'node:test'

import { createIpadNativeChromeTheme, getIpadToolbarLeft } from './ipad-native-chrome'

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

test('positions controls to the leading side of the centred iPad tab bar', () => {
  assert.equal(getIpadToolbarLeft(1_024, 360, 0), 167)
  assert.equal(getIpadToolbarLeft(768, 360, 0), 39)
  assert.equal(getIpadToolbarLeft(768, 600, 20), 32)
})
