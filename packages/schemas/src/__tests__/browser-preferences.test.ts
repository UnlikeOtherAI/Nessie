import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_VIEWPORT_PRESETS,
  BrowserHomepageSchema,
  BrowserViewportSchema,
  DEFAULT_BROWSER_HOMEPAGE,
  DEFAULT_BROWSER_VIEWPORT,
  browserViewportOrDefault,
  isNavigableHomepage,
  resolveBrowserHomepage,
} from '../browser-preferences.js'

test('a browser that has never been sized reads as the default laptop window', () => {
  assert.deepEqual(browserViewportOrDefault(null), DEFAULT_BROWSER_VIEWPORT)
  assert.deepEqual(browserViewportOrDefault(undefined), DEFAULT_BROWSER_VIEWPORT)
  // Half a pair is not a size. The database CHECK makes this unreachable, but
  // the reader of a row must not have to know that to be correct.
  assert.deepEqual(
    browserViewportOrDefault({ height: null, width: 1440 }),
    DEFAULT_BROWSER_VIEWPORT,
  )
  assert.deepEqual(
    browserViewportOrDefault({ height: 900, width: null }),
    DEFAULT_BROWSER_VIEWPORT,
  )
})

test('a sized browser reads back at its own size', () => {
  assert.deepEqual(
    browserViewportOrDefault({ height: 900, width: 1440 }),
    { height: 900, width: 1440 },
  )
})

test('the default is offered as a preset, so the control can show it selected', () => {
  const matching = BROWSER_VIEWPORT_PRESETS.find((preset) =>
    preset.viewport.width === DEFAULT_BROWSER_VIEWPORT.width
    && preset.viewport.height === DEFAULT_BROWSER_VIEWPORT.height,
  )
  assert.ok(matching, 'no preset matches the default viewport')
})

test('every preset is a viewport the schema and the database CHECK both accept', () => {
  for (const preset of BROWSER_VIEWPORT_PRESETS) {
    assert.equal(
      BrowserViewportSchema.safeParse(preset.viewport).success,
      true,
      `preset ${preset.id} is outside the accepted bounds`,
    )
  }
})

/**
 * A home page is typed by an administrator and then navigated to *inside an
 * agent's browser*, so the scheme check is not cosmetic: a `javascript:` URL
 * would run in the live view's page, and a credentialed one would put a
 * password in the tab strip and in every screenshot of it.
 */
test('a home page must be an ordinary http(s) address', () => {
  assert.equal(isNavigableHomepage('https://www.google.com'), true)
  assert.equal(isNavigableHomepage('http://intranet.example/start'), true)

  assert.equal(isNavigableHomepage('javascript:alert(1)'), false)
  assert.equal(isNavigableHomepage('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isNavigableHomepage('file:///etc/passwd'), false)
  assert.equal(isNavigableHomepage('https://user:secret@example.com'), false)
  assert.equal(isNavigableHomepage('not a url'), false)
  assert.equal(isNavigableHomepage(''), false)
})

test('the schema refuses what the checker refuses, with a sentence a person can act on', () => {
  const bad = BrowserHomepageSchema.safeParse('javascript:alert(1)')
  assert.equal(bad.success, false)
  assert.match(
    bad.success ? '' : bad.error.issues[0]?.message ?? '',
    /http:\/\/ or https:\/\//,
  )
  assert.equal(BrowserHomepageSchema.safeParse('  https://example.com  ').success, true)
})

test('anything unusable resolves to the default rather than failing a session open', () => {
  assert.equal(resolveBrowserHomepage(undefined), DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(resolveBrowserHomepage(null), DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(resolveBrowserHomepage(''), DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(resolveBrowserHomepage(42), DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(resolveBrowserHomepage('javascript:alert(1)'), DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(resolveBrowserHomepage('  https://example.com/start  '), 'https://example.com/start')
})
