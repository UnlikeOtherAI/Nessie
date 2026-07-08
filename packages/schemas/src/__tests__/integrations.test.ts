import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IntegratedProductResponseSchema,
  SetProductTeamEnablementRequestSchema,
} from '../integrations.js'

test('IntegratedProductResponseSchema accepts active team enablement state', () => {
  const parsed = IntegratedProductResponseSchema.parse({
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d101',
    accountLink: null,
    apiBaseUrl: null,
    authMode: 'oauth_mcp',
    capabilities: ['deep_research'],
    category: 'research',
    createdAt: '2026-07-08T12:00:00.000Z',
    defaultInstallState: 'native',
    healthDetail: null,
    healthStatus: 'setup_required',
    launchUrl: null,
    mcpCatalogEntryId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d601',
    mcpInstallation: {
      id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d701',
      catalogEntryId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d601',
      createdAt: '2026-07-08T12:00:00.000Z',
      healthFailureCount: 0,
      healthLastCheckedAt: '2026-07-08T12:02:00.000Z',
      lastError: null,
      lifecycleState: 'active',
      scopeId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d501',
      scopeType: 'team',
      toolCount: 5,
      updatedAt: '2026-07-08T12:02:00.000Z',
    },
    name: 'Deep Water',
    pluginManifestRef: 'first-party/deep-water',
    setupHint: null,
    slug: 'deep-water',
    sortOrder: 10,
    summary: 'Deep research runs.',
    teamEnablement: {
      id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d201',
      configuredByUserId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d301',
      createdAt: '2026-07-08T12:00:00.000Z',
      enabled: true,
      externalOrgId: 'uoa-org-1',
      externalTeamId: 'uoa-team-1',
      metadata: { authority: 'nessie_projection' },
      organizationId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d401',
      productSlug: 'deep-water',
      teamId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d501',
      updatedAt: '2026-07-08T12:00:00.000Z',
    },
    updatedAt: '2026-07-08T12:00:00.000Z',
  })

  assert.equal(parsed.teamEnablement?.enabled, true)
  assert.equal(parsed.teamEnablement?.externalTeamId, 'uoa-team-1')
  assert.equal(parsed.mcpInstallation?.lifecycleState, 'active')
  assert.equal(parsed.mcpInstallation?.toolCount, 5)
})

test('SetProductTeamEnablementRequestSchema requires a boolean enabled flag', () => {
  assert.deepEqual(SetProductTeamEnablementRequestSchema.parse({ enabled: false }), {
    enabled: false,
  })
  assert.equal(SetProductTeamEnablementRequestSchema.safeParse({ enabled: 'yes' }).success, false)
})
