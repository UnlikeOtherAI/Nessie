import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installedScopesEmptyMessage,
  type InstalledScopesEmptyState,
} from '../src/components/features/mcp-app-store/installed-scopes-empty.js'

const state = (
  overrides: Partial<InstalledScopesEmptyState> = {},
): InstalledScopesEmptyState => ({
  status: 'published',
  managedByIntegration: false,
  locked: false,
  isElevated: false,
  ...overrides,
})

test('a draft is told to publish, because it has no Install button yet', () => {
  const message = installedScopesEmptyMessage(state({ status: 'draft' }))
  assert.match(message, /Publish \(private\)/)
  assert.doesNotMatch(message, /click "Install"/)
})

test('only a published, installable connector is told to click Install', () => {
  assert.match(
    installedScopesEmptyMessage(state()),
    /Click "Install" on the connector/,
  )
})

test('no unreachable button is named in any other state', () => {
  const unreachable: InstalledScopesEmptyState[] = [
    state({ status: 'pending_approval' }),
    state({ status: 'rejected' }),
    state({ status: 'deprecated' }),
    state({ locked: true }),
    state({ managedByIntegration: true }),
  ]
  for (const candidate of unreachable) {
    assert.doesNotMatch(
      installedScopesEmptyMessage(candidate),
      /click "Install"/i,
      JSON.stringify(candidate),
    )
  }
})

test('a locked connector points at an admin, unless the viewer is one', () => {
  assert.match(
    installedScopesEmptyMessage(state({ locked: true })),
    /ask an admin/i,
  )
  // Elevated viewers can install despite the lock, so they get the normal call.
  assert.match(
    installedScopesEmptyMessage(state({ locked: true, isElevated: true })),
    /Click "Install"/,
  )
})

test('an integration-managed connector points at Integrations', () => {
  assert.match(
    installedScopesEmptyMessage(state({ managedByIntegration: true, status: 'published' })),
    /Integrations/,
  )
})
