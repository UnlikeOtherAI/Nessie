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
  appUnavailableReason,
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

test('connecting goes to the destination the server named, never one this client assembled', () => {
  const record = app()
  assert.deepEqual(appCardAction(record), {
    kind: 'link',
    href: record.installHref,
    label: 'Connect',
    tone: 'primary',
  })
  assert.deepEqual(appCardAction(app({ state: 'auth_expired' })), {
    kind: 'link',
    href: record.installHref,
    label: 'Reconnect',
    tone: 'primary',
  })
  assert.deepEqual(appCardAction(app({ state: 'error' })), {
    kind: 'link',
    href: record.installHref,
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
  assert.deepEqual(appCardAction(app({ managedByIntegration: true, state: 'auth_expired' })), {
    kind: 'disabled',
    label: 'Reconnect',
    title: 'Turned on from Integrations, not here.',
    tone: 'primary',
  })
})

test('an integration-managed app names Integrations even when it is also locked', () => {
  assert.equal(appUnavailableReason(app()), null)
  assert.equal(appUnavailableReason(app({ locked: true })), 'Managed by your admin.')
  assert.equal(
    appUnavailableReason(app({ locked: true, managedByIntegration: true })),
    'Turned on from Integrations, not here.',
  )
})

test('connecting is disabled without promising to resolve itself, because it may never', () => {
  // `connecting` is `pending_setup`: an install waiting on a key nobody has
  // entered sits there indefinitely.
  assert.deepEqual(appCardAction(app({ state: 'connecting' })), {
    kind: 'disabled',
    label: 'Connecting…',
    title: 'This connection has not finished setting up yet.',
    tone: 'primary',
  })
})

test('paused offers Manage alongside the connected states — its accounts are the person own', () => {
  for (const state of ['connected', 'multiple_accounts', 'paused'] as const) {
    assert.deepEqual(
      appCardAction(app({ state })),
      { kind: 'link', href: '/apps/github?tab=accounts', label: 'Manage', tone: 'secondary' },
      state,
    )
  }
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
