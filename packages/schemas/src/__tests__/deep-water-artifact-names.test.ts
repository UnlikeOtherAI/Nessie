import assert from 'node:assert/strict'
import test from 'node:test'

import { deepWaterArtifactFileName } from '../deep-water-artifact-names.js'
import { DeepWaterActiveRunConflictSchema } from '../deep-water-briefs.js'
import { IntegratedProductResponseSchema } from '../integrations.js'

/**
 * The names a finished research downloads under (Water plan nessie.md §7.9,
 * amendments N10) and the two wire shapes the admin's DeepWater surfaces read
 * beside the brief views: the readiness verdict on the products list, and the
 * run a refused team transition names.
 */

const run = (title: string | null, topic: string, reportKind: 'full' | 'summary' | null) => ({
  reportKind,
  title,
  topic,
})

test('a report is named by its title, and by its question until it has one', () => {
  assert.equal(
    deepWaterArtifactFileName(run('Heat pumps in Czech homes', 'Are heat pumps worth it?', 'full'), 'report'),
    'heat-pumps-in-czech-homes.md',
  )
  assert.equal(
    deepWaterArtifactFileName(run(null, 'Are heat pumps worth it?', null), 'report'),
    'are-heat-pumps-worth-it.md',
  )
  assert.equal(
    deepWaterArtifactFileName(run('   ', 'Tepelná čerpadla v Česku', 'full'), 'report'),
    'tepelna-cerpadla-v-cesku.md',
  )
})

test('a summary never downloads under the full report name', () => {
  assert.equal(
    deepWaterArtifactFileName(run('Grid storage', 'Grid storage', 'summary'), 'report'),
    'grid-storage-summary.md',
  )
})

test('sources share the report name and are a CSV', () => {
  assert.equal(deepWaterArtifactFileName(run('Grid storage', 'x', 'summary'), 'sources'), 'grid-storage.csv')
})

test('a name with nothing sluggable left still downloads as something readable', () => {
  assert.equal(deepWaterArtifactFileName(run('量子计算', '量子计算', 'full'), 'report'), 'deepwater-research.md')
})

test('a long title is cut at a word boundary of the slug, never mid-dash', () => {
  const name = deepWaterArtifactFileName(run('a'.repeat(79) + ' bcd', 'x', 'full'), 'report')
  assert.equal(name, `${'a'.repeat(79)}.md`)
})

test('the products list carries the DeepWater readiness verdict, and omits it elsewhere', () => {
  const base = {
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d101',
    accountLink: null,
    apiBaseUrl: null,
    authMode: 'uoa_sso',
    capabilities: [],
    category: 'research',
    createdAt: '2026-09-23T09:00:00.000Z',
    defaultInstallState: 'native',
    healthDetail: null,
    healthStatus: 'healthy',
    launchUrl: null,
    mcpCatalogEntryId: null,
    mcpInstallation: null,
    name: 'Deep Water',
    pluginManifestRef: null,
    setupHint: null,
    slug: 'deep-water',
    sortOrder: 1,
    summary: '',
    teamEnablement: null,
    updatedAt: '2026-09-23T09:00:00.000Z',
  }
  const withVerdict = IntegratedProductResponseSchema.parse({
    ...base,
    research: { state: 'team_off', viewerCanChangeTeam: true },
  })
  assert.deepEqual(withVerdict.research, { state: 'team_off', viewerCanChangeTeam: true })
  assert.equal(IntegratedProductResponseSchema.parse(base).research, undefined)
  assert.equal(
    IntegratedProductResponseSchema.safeParse({ ...base, research: { state: 'on', viewerCanChangeTeam: true } }).success,
    false,
  )
})

test('a refused transition names the open run without its topic', () => {
  const parsed = DeepWaterActiveRunConflictSchema.parse({
    channelId: '11111111-1111-4111-8111-111111111111',
    id: '22222222-2222-4222-8222-222222222222',
    originKind: 'agent',
    requestedByUserId: null,
    status: 'drafting',
  })
  assert.deepEqual(Object.keys(parsed).sort(), ['id', 'originKind', 'requestedByUserId', 'status'])
  assert.equal(
    DeepWaterActiveRunConflictSchema.safeParse({ id: 'x', originKind: 'person', requestedByUserId: null, status: 'running' })
      .success,
    false,
  )
})
