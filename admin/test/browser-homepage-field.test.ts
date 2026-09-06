import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { DEFAULT_BROWSER_HOMEPAGE } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { BrowserHomepageField } from '../src/components/features/browser-cloud/BrowserHomepageField.js'
import {
  browserHomepageFieldState,
  decideBrowserHomepageSave,
} from '../src/components/features/browser-cloud/browser-homepage-state.js'
import {
  SETTING_KEYS,
  type ResolvedSetting,
  type SettingScope,
} from '../src/facades/settings/hooks.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    .replaceAll('\r\n', '\n')

/** What `GET /api/settings/scoped` answers with, for the level being viewed. */
const resolved = (overrides: Partial<ResolvedSetting>): ResolvedSetting => ({
  canEdit: true,
  key: SETTING_KEYS.browserHomepage,
  lockedAtScope: null,
  lockedHere: false,
  setAtScope: null,
  value: null,
  ...overrides,
})

// Rendering the field needs the two providers its write hook is built on. It
// makes no request of its own — the setting arrives as a prop from the panel's
// one query — so any call through this client is a defect in the field.
const unusedApiClient: ApiClient = {
  delete: async () => {
    throw new Error('unexpected request')
  },
  get: async () => {
    throw new Error('unexpected request')
  },
  patch: async () => {
    throw new Error('unexpected request')
  },
  post: async () => {
    throw new Error('unexpected request')
  },
  put: async () => {
    throw new Error('unexpected request')
  },
}

const renderField = (setting: ResolvedSetting, scope: SettingScope): string =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        ApiClientProvider,
        { client: unusedApiClient },
        createElement(BrowserHomepageField, { scope, setting, teamId: null }),
      ),
    ),
  )

test('a level nobody has set shows the built-in default as its placeholder, not as its value', () => {
  const state = browserHomepageFieldState(resolved({}), 'organization')

  // Empty box, default behind it. Pre-filling the default instead would make
  // "nobody chose" indistinguishable from "somebody chose google.com", and the
  // first Save would turn the one into the other.
  assert.equal(state.ownValue, '')
  assert.equal(state.inheritedHomepage, DEFAULT_BROWSER_HOMEPAGE)
  assert.equal(state.overriddenHere, false)
  assert.equal(state.canEdit, true)
})

test('a level that sets nothing shows the address it inherits as its placeholder', () => {
  const state = browserHomepageFieldState(
    resolved({ setAtScope: 'organization', value: 'https://intranet.example.com/start' }),
    'user',
  )

  assert.equal(state.ownValue, '')
  assert.equal(state.inheritedHomepage, 'https://intranet.example.com/start')
  // Nothing to clear: this level has no override, so the panel offers none.
  assert.equal(state.overriddenHere, false)
})

test('a level with its own address shows it, and has an override to clear', () => {
  const state = browserHomepageFieldState(
    resolved({ setAtScope: 'team', value: 'https://team.example.com' }),
    'team',
  )

  assert.equal(state.ownValue, 'https://team.example.com')
  assert.equal(state.overriddenHere, true)
  // The placeholder must not echo the address the box already holds: the
  // instant somebody empties the field to drop the override, a placeholder
  // repeating it would claim that clearing changes nothing. The resolver
  // stopped at this level, so what would really take over is not in the
  // answer — the default is the only honest thing to show until the refetch.
  assert.equal(state.inheritedHomepage, DEFAULT_BROWSER_HOMEPAGE)
})

test('a value that is not an address reads as unset rather than as an invisible override', () => {
  // A row written before this key existed, or edited by hand. Reporting it as
  // an override would offer a Clear button for text the field cannot show.
  const state = browserHomepageFieldState(
    resolved({ setAtScope: 'user', value: { url: 'https://example.com' } }),
    'user',
  )

  assert.equal(state.ownValue, '')
  assert.equal(state.overriddenHere, false)
  assert.equal(state.inheritedHomepage, DEFAULT_BROWSER_HOMEPAGE)
})

test('a level below a lock cannot edit, still sees what is in force, and is told which level decided', () => {
  const lockedAbove = resolved({
    canEdit: false,
    lockedAtScope: 'organization',
    setAtScope: 'organization',
    value: 'https://intranet.example.com/start',
  })
  const state = browserHomepageFieldState(lockedAbove, 'team')

  assert.equal(state.canEdit, false)
  assert.equal(state.lockedHere, false)
  // The address still shows — hiding it would leave a person wondering where
  // their browser came from.
  assert.equal(state.inheritedHomepage, 'https://intranet.example.com/start')

  // On screen that is `ScopedSettingGate`'s sentence, not a second one written
  // here, and the control stays visible rather than disappearing.
  const html = renderField(lockedAbove, 'team')
  assert.match(html, /This has been set at the organisation level and cannot be changed here\./)
  assert.match(html, /<input[^>]*disabled=""/)
  assert.match(html, /placeholder="https:\/\/intranet\.example\.com\/start"/)
  // Nothing below a lock may set the key, so this level is offered no lock of
  // its own to pass further down.
  assert.doesNotMatch(html, /Use this everywhere/)
})

test('the level holding the lock still edits its own value', () => {
  // `isLockedAbove` is strictly above: locking is how a level sets a value
  // *and* stops the ones below overriding it.
  const state = browserHomepageFieldState(
    resolved({
      canEdit: true,
      lockedAtScope: 'organization',
      lockedHere: true,
      setAtScope: 'organization',
      value: 'https://intranet.example.com/start',
    }),
    'organization',
  )

  assert.equal(state.canEdit, true)
  assert.equal(state.lockedHere, true)
  assert.equal(state.ownValue, 'https://intranet.example.com/start')
})

test('an address the browser must not be sent to is refused before anything is sent', () => {
  for (const address of ['javascript:alert(1)', 'data:text/html,<b>x', 'https://user:pass@example.com']) {
    const decision = decideBrowserHomepageSave(address)
    assert.equal(decision.kind, 'refused', `${address} reached the server`)
    assert.equal(
      decision.kind === 'refused' ? decision.message : '',
      // The schema's own sentence — the one the server would answer with.
      'Enter a http:// or https:// address with no username or password in it.',
    )
  }

  assert.equal(decideBrowserHomepageSave('not a url at all').kind, 'refused')

  // And the field acts on that answer before it writes anything: the refusal
  // returns, rather than showing a message beside a request already in flight.
  const field = readSource('../src/components/features/browser-cloud/BrowserHomepageField.tsx')
  const saveBody = field.slice(field.indexOf('const save ='), field.indexOf('const clear ='))
  assert.ok(
    saveBody.indexOf('setInvalid(decision.message)') < saveBody.indexOf('commit('),
    'the refusal is handled before any commit',
  )
})

test('an empty box clears the override rather than failing validation', () => {
  // The one way to drop a level's own address and follow the level above.
  assert.deepEqual(decideBrowserHomepageSave(''), { kind: 'clear' })
  assert.deepEqual(decideBrowserHomepageSave('   '), { kind: 'clear' })
})

test('a saved address is trimmed, exactly as the schema stores it', () => {
  assert.deepEqual(
    decideBrowserHomepageSave('  https://example.com/start  '),
    { kind: 'save', value: 'https://example.com/start' },
  )
})

test('neither half of the row is dropped by writing the other', () => {
  // A write replaces the level's whole row: `writeScopedSetting` stores
  // `value` and `locked` together, so a control that sends only its own half
  // silently clears the other. The lock checkbox releasing an address, and a
  // Save releasing the lock, are the same one-line mistake.
  const field = readSource('../src/components/features/browser-cloud/BrowserHomepageField.tsx')

  assert.match(field, /commit\(decision\.value, state\.lockedHere, 'Home page saved\.'\)/)
  assert.match(field, /commit\(null, state\.lockedHere, 'Home page cleared\.'\)/)
  // The lock toggle resends the address the server holds, never the box —
  // flipping a checkbox must not commit an edit nobody pressed Save on.
  assert.match(field, /onChange=\{\(locked\) => commit\(state\.ownValue \|\| null, locked, 'Saved\.'\)\}/)
})

test('the field is a real label pointing at a real control, with an empty box over the placeholder', () => {
  const html = renderField(
    resolved({ setAtScope: 'organization', value: 'https://intranet.example.com/start' }),
    'user',
  )

  const label = /<label[^>]*for="([^"]+)"[^>]*>Home page/.exec(html)
  assert.ok(label, 'the field has a real <label> for its control')
  const id = label[1]
  // The same id on the control, so clicking the label lands in the box and a
  // screen reader reads the two together. An aria-label would leave nothing to
  // click and nothing to read beside the field.
  assert.match(html, new RegExp(`<input[^>]*id="${id}"`))
  // Described by its help line, and — through FormField, which owns that
  // contract — by the error region as soon as one is set.
  assert.match(html, new RegExp(`<input[^>]*aria-describedby="${id}-help"`))
  const field = readSource('../src/components/features/browser-cloud/BrowserHomepageField.tsx')
  assert.match(field, /error=\{invalid \?\? undefined\}/)

  // Inherited, so: nothing in the box, the address behind it, and no Clear.
  assert.match(html, /placeholder="https:\/\/intranet\.example\.com\/start"/)
  assert.doesNotMatch(html, /value="https:\/\/intranet\.example\.com\/start"/)
  assert.doesNotMatch(html, />Clear</)
})

test('a level with an override of its own is offered the way back to the level above', () => {
  const html = renderField(
    resolved({ setAtScope: 'user', value: 'https://example.com/start' }),
    'user',
  )

  assert.match(html, /value="https:\/\/example\.com\/start"/)
  assert.match(html, />Clear</)
  // A personal setting locks nobody, so the lock never appears at that level.
  assert.doesNotMatch(html, /Use this everywhere/)
})

test('an editable level above people can pin the address for everyone below it', () => {
  const html = renderField(resolved({}), 'organization')

  assert.match(html, /Use this everywhere/)
  assert.match(html, new RegExp(`placeholder="${DEFAULT_BROWSER_HOMEPAGE}"`))
})

test('the panel reads both browser keys through the one cascade query', () => {
  const panel = readSource('../src/components/features/browser-cloud/CloudBrowserPanel.tsx')

  assert.match(panel, /\[SETTING_KEYS\.browserConnection, SETTING_KEYS\.browserHomepage\]/)
  assert.match(panel, /<BrowserHomepageField scope=\{scope\} setting=\{homepageSetting\} teamId=\{teamId\} \/>/)
})
