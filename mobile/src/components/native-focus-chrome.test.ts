import assert from 'node:assert/strict'
import test from 'node:test'

import { NATIVE_FOCUS_CHROME, applyNativeFocusChrome } from './native-focus-chrome'
import {
  DEFAULT_NATIVE_SHELL_PRESENTATION,
  reduceNativeShellPresentation,
  type NativeShellPresentation,
} from './native-shell-presentation'

const themed = (): NativeShellPresentation =>
  reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, {
    type: 'theme',
    accent: '#b45309',
    accentStrong: '#7c2d12',
    headerSurface: '#f1e9dc',
    headerText: '#2b2018',
    inactive: '#806b58',
    scheme: 'light',
    surface: '#fffdf8',
    text: '#2b2018',
    textMuted: '#74665b',
  })

const withFocus = (
  presentation: NativeShellPresentation,
  focusModeEnabled: boolean,
): NativeShellPresentation => ({
  ...presentation,
  nativeAccount: { ...presentation.nativeAccount, focusModeEnabled },
})

test('focus mode gives the native chrome the monochrome navigation palette', () => {
  const focused = applyNativeFocusChrome(withFocus(themed(), true))

  assert.equal(focused.phoneHeaderSurface, '#242424')
  assert.equal(focused.phoneHeaderText, '#f1f1f1')
  assert.equal(focused.chromeSurface, '#353535')
  assert.equal(focused.accent, '#b9b9bc')
  assert.equal(focused.strongAccent, '#ececee')
  assert.equal(focused.inactive, '#aeaeaf')
})

// The beige Sandstone header was the visible symptom: a themed rail sitting
// over a page that had gone black and white.
test('no themed colour survives into the focused native chrome', () => {
  const focused = applyNativeFocusChrome(withFocus(themed(), true))

  assert.notEqual(focused.phoneHeaderSurface, '#f1e9dc')
  assert.notEqual(focused.accent, '#b45309')
})

test('leaving focus mode restores every themed native colour', () => {
  const themedPresentation = withFocus(themed(), false)

  assert.deepEqual(applyNativeFocusChrome(themedPresentation), themedPresentation)
})

// The page still owns its own background, so the frame behind the WebView and
// the status-bar contrast that derives from it keep following the work surface.
test('focus mode leaves the page-supplied background alone', () => {
  const page = reduceNativeShellPresentation(withFocus(themed(), true), {
    type: 'bg',
    color: '#ffffff',
  })

  assert.equal(applyNativeFocusChrome(page).background, '#ffffff')
})

test('the focus chrome palette never carries a background of its own', () => {
  assert.equal('background' in NATIVE_FOCUS_CHROME, false)
})
