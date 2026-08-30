import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppSummaryRecord } from '@nessie/schemas'

import {
  appCardAction,
  appCardMeta,
  appCardStatus,
  appCardTestId,
  appCategoryLabel,
  appDetailHref,
  appIconInitials,
  appKindPill,
  appUnavailableExplanation,
} from '../src/components/features/apps/app-card-presentation.js'

/**
 * One card renders every app, so the differences between a remote connector, a
 * first-party built-in and a locked entry are values decided here rather than a
 * second card component.
 */

const app = (overrides: Partial<AppSummaryRecord> = {}): AppSummaryRecord => ({
  aliases: [],
  appSource: 'nessie',
  categories: ['development'],
  connectionCount: 0,
  displayName: 'GitHub',
  distribution: 'remote',
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: 'app-1',
  installHref: '/mcp-app-store?catalogEntryId=app-1&action=install',
  locked: false,
  managedByIntegration: false,
  name: 'github',
  primaryCategory: 'development',
  promptCount: null,
  resourceCount: null,
  shortDescription: 'Repositories, issues and pull requests.',
  slug: 'github',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: null,
  ...overrides,
})

test('the detail route prefers the slug, falls back to the id, and escapes both', () => {
  assert.equal(appDetailHref(app()), '/apps/github')
  assert.equal(appDetailHref(app(), 'accounts'), '/apps/github?tab=accounts')
  // A pasted URL has to survive a rename, but an app with no slug yet still
  // has to be reachable.
  assert.equal(appDetailHref(app({ slug: null })), '/apps/app-1')
  assert.equal(appDetailHref(app({ slug: 'a b/c' })), '/apps/a%20b%2Fc')
})

test('an un-iconed app falls back to initials rather than to a shelf of identical tiles', () => {
  assert.equal(appIconInitials('Linear'), 'LI')
  assert.equal(appIconInitials('Google Drive'), 'GD')
  assert.equal(appIconInitials('  Notion   Calendar  '), 'NC')
  assert.equal(appIconInitials('x'), 'X')
  assert.equal(appIconInitials('   '), '?')
})

test('a built-in was never connected to anything, so it says available instead of connected', () => {
  assert.deepEqual(appCardStatus(app({ distribution: 'builtin' })), {
    kind: 'quiet',
    label: '● Always available',
  })
  // The exception is scoped to `available`: a built-in in any other state
  // reports that state like everything else.
  assert.deepEqual(appCardStatus(app({ distribution: 'builtin', state: 'error' })), {
    kind: 'pill',
    label: '⚠ Connection error',
    tone: 'danger',
  })
})

test('an available app shows no status at all — absence is the signal', () => {
  assert.deepEqual(appCardStatus(app()), { kind: 'none' })
})

test('each connected state gets its own pill, and the two verdict states stay quiet text', () => {
  assert.deepEqual(appCardStatus(app({ state: 'connecting' })), {
    kind: 'pill',
    label: 'Connecting…',
    tone: 'accent',
  })
  assert.deepEqual(appCardStatus(app({ state: 'connected' })), {
    kind: 'pill',
    label: '● Connected',
    tone: 'success',
  })
  assert.deepEqual(appCardStatus(app({ connectionCount: 3, state: 'multiple_accounts' })), {
    kind: 'pill',
    label: '● 3 accounts',
    tone: 'success',
  })
  assert.deepEqual(appCardStatus(app({ state: 'auth_expired' })), {
    kind: 'pill',
    label: '⚠ Reconnect',
    tone: 'warning',
  })
  // Same dot vocabulary as "connected", hollow: the relationship exists, off.
  assert.deepEqual(appCardStatus(app({ state: 'paused' })), {
    kind: 'pill',
    label: '○ Turned off',
    tone: 'muted',
  })
  assert.deepEqual(appCardStatus(app({ state: 'disabled' })), {
    kind: 'quiet',
    label: 'Unavailable',
  })
  assert.deepEqual(appCardStatus(app({ state: 'unavailable' })), {
    kind: 'quiet',
    label: 'Not available right now',
  })
})

test('a built-in offers Open, not Connect — there is no account, only a surface', () => {
  assert.deepEqual(appCardAction(app({ distribution: 'builtin' })), {
    kind: 'link',
    href: '/apps/github',
    label: 'Open',
    tone: 'secondary',
  })
})

test('connecting is a button that opens the dialog on this page, never a navigation', () => {
  // The card used to link to `installHref` — the Connectors page's install
  // form. Connect now happens in the AppConnectDialog on /apps, so the action
  // is a button and the record's `installHref` never reaches the footer.
  assert.deepEqual(appCardAction(app()), {
    kind: 'connect',
    label: 'Connect',
    tone: 'primary',
  })
  assert.deepEqual(appCardAction(app({ state: 'auth_expired' })), {
    kind: 'connect',
    label: 'Reconnect',
    tone: 'primary',
  })
  assert.deepEqual(appCardAction(app({ state: 'error' })), {
    kind: 'connect',
    label: 'Retry',
    tone: 'primary',
  })
})

test('somebody else owning the decision disables the button rather than hiding it', () => {
  // A missing button reads as a missing feature; a disabled one with a reason
  // reads as somebody else's call.
  assert.deepEqual(appCardAction(app({ locked: true })), {
    kind: 'disabled',
    label: 'Connect',
    title: 'Managed by your admin.',
    tone: 'primary',
  })
  // The card keeps a plain sentence: `title` is a tooltip and cannot hold an
  // anchor. The detail hero renders the same sentence with the link.
  assert.deepEqual(appCardAction(app({ managedByIntegration: true, state: 'auth_expired' })), {
    kind: 'disabled',
    label: 'Reconnect',
    title: 'Turned on from Integrations, not here.',
    tone: 'primary',
  })
})

test('an integration-managed app names Integrations even when it is also locked', () => {
  assert.equal(appUnavailableExplanation(app()), null)
  assert.deepEqual(appUnavailableExplanation(app({ locked: true })), {
    link: null,
    text: 'Managed by your admin.',
  })
  // Naming the door is not opening it, so the sentence carries the way there.
  assert.deepEqual(appUnavailableExplanation(app({ locked: true, managedByIntegration: true })), {
    link: { href: '/settings/integrations', label: 'Open Integrations' },
    text: 'Turned on from Integrations, not here.',
  })
})

test('each availability verdict is worded, and says who can change it', () => {
  // These used to return null, so the detail hero — whose whole job is to
  // explain — rendered a bare "Unavailable" with no sentence under it.
  const blocked = appUnavailableExplanation(app({ state: 'disabled', trustLevel: 'blocked' }))
  assert.match(blocked?.text ?? '', /Blocked for this organisation/)
  assert.match(blocked?.text ?? '', /An owner can lift that/)

  const deprecated = appUnavailableExplanation(app({ state: 'disabled' }))
  assert.match(deprecated?.text ?? '', /No longer offered by its publisher/)
  assert.match(deprecated?.text ?? '', /An owner can point you at a replacement/)

  const unreachable = appUnavailableExplanation(app({ state: 'unavailable' }))
  assert.match(unreachable?.text ?? '', /could not reach this app's server/)
  assert.match(unreachable?.text ?? '', /an owner can look into it/)
})

test('a verdict is never worded over an app that is connected and working', () => {
  // The wording keys off the two action-less states, not off the raw flags, so
  // a blocked trust level on a live connection cannot produce a refusal.
  assert.equal(appUnavailableExplanation(app({ state: 'connected', trustLevel: 'blocked' })), null)
  assert.equal(appUnavailableExplanation(app({ state: 'error', trustLevel: 'blocked' })), null)
})

test('connecting offers the way on, without promising to resolve itself', () => {
  // `connecting` is `pending_setup`: an install waiting on a key nobody has
  // entered sits there indefinitely, so the label must not say "Finishing".
  // It was a *disabled* "Connecting…" beside a "Connecting…" pill — two
  // elements, one word, nothing to click — which read as a rendering fault on
  // the card. The state stays on the pill; the action is the doorway.
  assert.deepEqual(appCardAction(app({ state: 'connecting' })), {
    kind: 'link',
    href: appDetailHref(app({ state: 'connecting' }), 'accounts'),
    label: 'Finish setup',
    tone: 'secondary',
  })
})

test('the connecting pill and its action never say the same word', () => {
  const status = appCardStatus(app({ state: 'connecting' }))
  const action = appCardAction(app({ state: 'connecting' }))
  assert.equal(status.kind, 'pill')
  assert.notEqual(status.kind === 'pill' ? status.label : null, action.kind === 'none' ? null : action.label)
})

test('paused opens the accounts tab to look, because nothing re-enables an install', () => {
  for (const state of ['connected', 'multiple_accounts'] as const) {
    assert.deepEqual(
      appCardAction(app({ state })),
      { kind: 'link', href: '/apps/github?tab=accounts', label: 'Manage', tone: 'secondary' },
      state,
    )
  }
  // "Manage" promised a control the accounts tab does not have and no endpoint
  // backs: a paused install cannot be switched back on anywhere in the product.
  assert.deepEqual(appCardAction(app({ state: 'paused' })), {
    kind: 'link',
    href: '/apps/github?tab=accounts',
    label: 'View accounts',
    tone: 'secondary',
  })
})

test('the two availability verdicts offer no card action — the detail page says why in words', () => {
  assert.deepEqual(appCardAction(app({ state: 'disabled' })), { kind: 'none' })
  assert.deepEqual(appCardAction(app({ state: 'unavailable' })), { kind: 'none' })
})

test('at most one attribute pill, and how an app is delivered earns none by itself', () => {
  assert.deepEqual(appKindPill(app({ distribution: 'builtin', featured: true })), {
    label: 'Featured',
    tone: 'accent',
  })
  assert.deepEqual(appKindPill(app({ distribution: 'builtin' })), {
    label: 'Built-in',
    tone: 'neutral',
  })
  assert.deepEqual(appKindPill(app()), { label: 'Remote', tone: 'info' })
  assert.equal(appKindPill(app({ distribution: 'package' })), null)
})

test('the meta line answers what do I get, and only names the publisher when it cannot', () => {
  assert.equal(appCardMeta(app({ toolCount: 5 })), '5 capabilities')
  assert.equal(appCardMeta(app({ toolCount: 1 })), '1 capability')
  // Zero is a probe result, not an un-probed app: it is reported, not hidden.
  assert.equal(appCardMeta(app({ toolCount: 0 })), '0 capabilities')
  assert.equal(appCardMeta(app({ toolCount: 2, vendor: 'GitHub, Inc.' })), '2 capabilities')
  assert.equal(appCardMeta(app({ vendor: 'GitHub, Inc.' })), 'By GitHub, Inc.')
  assert.equal(appCardMeta(app()), null)
})

test('the category label and the per-app test hook read from the record, not from the id', () => {
  assert.equal(appCategoryLabel(app({ primaryCategory: 'crm_sales' })), 'CRM & Sales')
  assert.equal(appCardTestId(app()), 'app-card-github')
  assert.equal(appCardTestId(app({ slug: null })), 'app-card-app-1')
})
