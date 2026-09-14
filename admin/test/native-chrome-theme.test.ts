import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  isIosPhoneShell,
  isTransparentColour,
  NATIVE_CHROME_PALETTE_SELECTOR,
  readNativeBackdrop,
  readNativeChromeTheme,
} from '../src/lib/native-chrome-theme.js'

const palette = (tokens: Record<string, string>, colorScheme = 'dark') => ({
  colorScheme,
  getPropertyValue: (name: string) => ` ${tokens[name] ?? ''} `,
})

const NESSIE_CHROME = palette({
  '--accent': '#2f80ed',
  '--accent-strong': '#8cc5ff',
  '--main': '#13223b',
  '--on-accent': '#ffffff',
  '--panel': '#13223b',
  '--rail': '#0b172a',
  '--tx': '#ffffff',
  '--tx2': '#d5deea',
  '--tx3': '#9fb0c8',
})

test('the theme message carries the chrome palette, not the work surface', () => {
  assert.deepEqual(readNativeChromeTheme(NESSIE_CHROME), {
    accent: '#2f80ed',
    accentStrong: '#8cc5ff',
    chromeSource: 'page',
    headerSurface: '#0b172a',
    headerText: '#ffffff',
    inactive: '#9fb0c8',
    onAccent: '#ffffff',
    scheme: 'dark',
    surface: '#13223b',
    text: '#ffffff',
    textMuted: '#d5deea',
    type: 'theme',
  })
})

test('the backdrop is the chrome rail, its --main on an iPhone, and the work surface in focus', () => {
  assert.equal(readNativeBackdrop({ focusSurface: null, iosPhone: false, palette: NESSIE_CHROME }), '#0b172a')
  assert.equal(readNativeBackdrop({ focusSurface: null, iosPhone: true, palette: NESSIE_CHROME }), '#13223b')
  assert.equal(
    readNativeBackdrop({ focusSurface: 'rgb(255, 255, 255)', iosPhone: true, palette: NESSIE_CHROME }),
    'rgb(255, 255, 255)',
  )
})

test('only an iOS phone shell reads the iPhone backdrop', () => {
  assert.equal(isIosPhoneShell({ formFactor: 'phone', platform: 'ios' }), true)
  assert.equal(isIosPhoneShell({ formFactor: 'large-phone-landscape', platform: 'ios' }), true)
  assert.equal(isIosPhoneShell({ formFactor: 'ipad', platform: 'ios' }), false)
  assert.equal(isIosPhoneShell({ formFactor: 'phone', platform: 'android' }), false)
  assert.equal(isIosPhoneShell(null), false)
})

test('a transparent shell background never becomes the backdrop', () => {
  assert.equal(isTransparentColour('rgba(0, 0, 0, 0)'), true)
  assert.equal(isTransparentColour('transparent'), true)
  assert.equal(isTransparentColour(''), true)
  assert.equal(isTransparentColour('rgb(255, 255, 255)'), false)
})

// The palette element is only as good as the rules that reach it: a chrome
// scope that forgets it would publish the work surface to the native header,
// which is exactly how the white iPhone header under Nessie happened.
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

const ruleSelectorsContaining = (declaration: string): string[] => {
  const rules: string[] = []
  const pattern = /([^{}]+)\{([^}]*)\}/g
  for (const match of styles.matchAll(pattern)) {
    if (match[2]?.includes(declaration)) rules.push(match[1]!.trim())
  }
  return rules
}

test('every rule that re-scopes chrome tokens also reaches the native palette element', () => {
  const nessieChrome = ruleSelectorsContaining('--rail: #0b172a;')
    .find((selectors) => selectors.includes('.admin-frame > .admin-topbar'))
  assert.ok(nessieChrome, 'the Nessie chrome rule was not found')
  assert.match(nessieChrome, /:where\(\[data-theme="nessie"\]\) \.admin-frame > \.native-chrome-palette/)

  const focusChrome = ruleSelectorsContaining('--rail: #242424;')
    .find((selectors) => selectors.includes('.focus-mode > .admin-topbar'))
  assert.ok(focusChrome, 'the focus-mode chrome rule was not found')
  assert.match(focusChrome, /\.focus-mode > \.native-chrome-palette/)

  // Focus wins on equal specificity only by coming later.
  assert.ok(styles.indexOf(nessieChrome) < styles.indexOf(focusChrome))
})

test('the bridge reads the element exactly where styles.css addresses it', () => {
  assert.equal(NATIVE_CHROME_PALETTE_SELECTOR, '.admin-frame > .native-chrome-palette')
})
