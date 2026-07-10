import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BuildMeProjectHandoffRequestSchema,
  DeepWaterResearchRunRecordSchema,
  DeepTestReviewHandoffRequestSchema,
  DeepWaterResearchLaunchRequestSchema,
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
      authority: 'nessie_projection',
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
    usageSummary: {
      currency: 'USD',
      failureCount: 1,
      lastOperation: 'research_create',
      lastUsedAt: '2026-07-08T12:04:00.000Z',
      monthStart: '2026-07-01T00:00:00.000Z',
      successCount: 7,
      totalCalls: 8,
      totalCost: 3.25,
      totalUnits: 42,
    },
  })

  assert.equal(parsed.teamEnablement?.enabled, true)
  assert.equal(parsed.teamEnablement?.authority, 'nessie_projection')
  assert.equal(parsed.teamEnablement?.externalTeamId, 'uoa-team-1')
  assert.equal(parsed.mcpInstallation?.lifecycleState, 'active')
  assert.equal(parsed.mcpInstallation?.toolCount, 5)
  assert.equal(parsed.usageSummary.totalCalls, 8)
  assert.equal(parsed.usageSummary.lastOperation, 'research_create')
})

test('SetProductTeamEnablementRequestSchema requires a boolean enabled flag', () => {
  assert.deepEqual(SetProductTeamEnablementRequestSchema.parse({ enabled: false }), {
    enabled: false,
  })
  assert.equal(SetProductTeamEnablementRequestSchema.safeParse({ enabled: 'yes' }).success, false)
})

test('DeepWaterResearchLaunchRequestSchema keeps launcher controls MCP-safe', () => {
  const parsed = DeepWaterResearchLaunchRequestSchema.parse({
    depth: 'deep',
    query: 'Map the commercial risks for EU geothermal projects.',
    searchQuality: 'premium',
    title: 'Geothermal risk map',
  })

  assert.equal(parsed.depth, 'deep')
  assert.equal(parsed.query, 'Map the commercial risks for EU geothermal projects.')
  assert.equal(parsed.outputTier, 'full')
  assert.equal(parsed.artifactDestination, 'knowledge_draft')
  assert.equal(parsed.searchQuality, 'premium')
  const withBudget = DeepWaterResearchLaunchRequestSchema.parse({
    budgetUsd: 100,
    depth: 'deep',
    query: 'x',
  })
  assert.equal('budgetUsd' in withBudget, false)
  assert.equal(
    DeepWaterResearchLaunchRequestSchema.safeParse({
      depth: 'uncapped',
      query: 'x',
    }).success,
    false,
  )
})

test('DeepWaterResearchRunRecordSchema accepts durable Deep Water run projection', () => {
  const parsed = DeepWaterResearchRunRecordSchema.parse({
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d801',
    artifactDestination: 'knowledge_draft',
    channelId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d802',
    completedAt: null,
    connectorId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d803',
    createdAt: '2026-07-10T10:30:00.000Z',
    currency: null,
    depth: 'deep',
    externalRunId: null,
    knowledgePageId: null,
    messageId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d804',
    organizationId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d401',
    outputTier: 'full',
    productSlug: 'deep-water',
    queryPreview: 'Map geothermal project risks.',
    reportUrl: 'https://deepwater.example/reports/research-123',
    requestedAt: '2026-07-10T10:30:00.000Z',
    requestedByUserId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d301',
    searchQuality: 'premium',
    sourceCount: 18,
    status: 'completed',
    statusDetail: 'Report ready for review.',
    teamId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d501',
    threadId: '8f3a5a00-0e64-4d10-a517-0d0b69c1d805',
    title: 'Geothermal risk map',
    totalCost: 4.25,
    updatedAt: '2026-07-10T10:30:00.000Z',
  })

  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.productSlug, 'deep-water')
  assert.equal(parsed.depth, 'deep')
  assert.equal(parsed.reportUrl, 'https://deepwater.example/reports/research-123')
  assert.equal(parsed.sourceCount, 18)
})

test('DeepTestReviewHandoffRequestSchema rejects target material fields', () => {
  const parsed = DeepTestReviewHandoffRequestSchema.parse({
    artifactPolicy: 'share_safe_report',
    depth: 'overnight',
    runner: 'local_mcp',
  })

  assert.equal(parsed.depth, 'overnight')
  assert.equal(parsed.artifactPolicy, 'share_safe_report')
  assert.equal(parsed.runner, 'local_mcp')
  assert.deepEqual(DeepTestReviewHandoffRequestSchema.parse({}), {
    artifactPolicy: 'share_safe_report',
    depth: 'standard',
    runner: 'local_mcp',
  })
  assert.equal(
    DeepTestReviewHandoffRequestSchema.safeParse({
      depth: 'deep',
      targetUrl: 'https://api.customer.example',
    }).success,
    false,
  )
  assert.equal(
    DeepTestReviewHandoffRequestSchema.safeParse({
      depth: 'deep',
      prompt: 'review this diff',
    }).success,
    false,
  )
})

test('BuildMeProjectHandoffRequestSchema rejects board sync payload fields', () => {
  const parsed = BuildMeProjectHandoffRequestSchema.parse({
    contextScope: 'active_team',
    intent: 'board_source_discovery',
  })

  assert.equal(parsed.contextScope, 'active_team')
  assert.equal(parsed.intent, 'board_source_discovery')
  assert.deepEqual(BuildMeProjectHandoffRequestSchema.parse({}), {
    contextScope: 'active_project',
    intent: 'project_definition',
  })
  assert.equal(
    BuildMeProjectHandoffRequestSchema.safeParse({
      boardId: 'buildme-board-1',
      intent: 'board_source_discovery',
    }).success,
    false,
  )
  assert.equal(
    BuildMeProjectHandoffRequestSchema.safeParse({
      columnMapping: { todo: 'Backlog' },
      intent: 'board_source_discovery',
    }).success,
    false,
  )
  assert.equal(
    BuildMeProjectHandoffRequestSchema.safeParse({
      intent: 'sync_now',
    }).success,
    false,
  )
})
