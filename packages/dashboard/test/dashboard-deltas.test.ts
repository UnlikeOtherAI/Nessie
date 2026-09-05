import assert from 'node:assert/strict'
import test from 'node:test'

import type { DashboardContext } from '../src/services/dashboards.js'
import {
  applyDashboardDelta,
  DashboardRevisionConflictError,
} from '../src/services/dashboard-deltas.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const dashboardId = '00000000-0000-4000-8000-000000000003'
const mutationId = '00000000-0000-4000-8000-000000000004'

const createContext = () => {
  let revision = 2
  let layout = { lg: [], md: [], sm: [] }
  let presentation = { attributions: [], filters: [], insights: [], style: 'standard' }
  let updateClaims = 0
  const mutations = new Map<string, {
    baseRevision: number
    operations: unknown
    revision: number
  }>()
  const persistedDeltas: { runId?: string | null }[] = []
  const persistedVersions: { runId?: string | null }[] = []
  const dashboard = {
    archivedAt: null,
    channelId: null,
    createdBy: userId,
    home: 'personal',
    id: dashboardId,
    organizationId,
    ownerUserId: userId,
    projectId: null,
    teamId: null,
  }
  const prisma = {
    dashboard: {
      findFirst: async (input: { include?: unknown; select?: unknown }) => input.include
        ? { ...dashboard, layout, presentation, revision, widgets: [] }
        : { ...dashboard, layout, presentation, revision },
      findUnique: async () => ({ revision }),
      update: async (input: { data: { layout: typeof layout; presentation: typeof presentation } }) => {
        layout = input.data.layout
        presentation = input.data.presentation
        return { id: dashboardId, layout, presentation, revision }
      },
      updateMany: async (input: { where: { revision: number } }) => {
        if (input.where.revision !== revision) return { count: 0 }
        revision += 1
        updateClaims += 1
        return { count: 1 }
      },
    },
    dashboardDataSource: { findFirst: async () => null },
    dashboardDelta: {
      create: async (input: { data: { mutationId: string; revision: number; runId?: string | null } }) => {
        mutations.set(input.data.mutationId, {
          baseRevision: (input.data as { baseRevision: number }).baseRevision,
          operations: (input.data as { operations: unknown }).operations,
          revision: input.data.revision,
        })
        persistedDeltas.push(input.data)
        return input.data
      },
      findUnique: async (input: { where: { dashboardId_mutationId: { mutationId: string } } }) =>
        mutations.get(input.where.dashboardId_mutationId.mutationId) ?? null,
    },
    dashboardGrant: { findMany: async () => [] },
    dashboardSourceMaterial: { findMany: async () => [] },
    dashboardVersion: {
      create: async (input: { data: { runId?: string | null } }) => {
        persistedVersions.push(input.data)
        return {}
      },
    },
    dashboardWidget: {
      create: async () => { throw new Error('not used') },
      delete: async () => { throw new Error('not used') },
      update: async () => { throw new Error('not used') },
    },
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(prisma),
  }
  const context = {
    actor: { organizationId, role: 'member' as const, userId },
    membership: {
      canReadKnowledgePageVersion: async () => false,
      canReadMessage: async () => false,
      isChannelMember: async () => false,
      isProjectMember: async () => false,
      isTeamMember: async () => false,
      subjectsForActor: async () => [],
    },
    prisma,
  } as unknown as DashboardContext
  return {
    context,
    persistedDeltas: () => persistedDeltas,
    persistedVersions: () => persistedVersions,
    updateClaims: () => updateClaims,
  }
}

const layoutDelta = (id: string, baseRevision = 2) => ({
  baseRevision,
  dashboardId,
  mutationId: id,
  operations: [{ layout: { lg: [], md: [], sm: [] }, type: 'set_layout' as const }],
  schemaVersion: 1 as const,
})

test('agent dashboard deltas retain the run that made the auditable change', async () => {
  const fake = createContext()
  const runId = '00000000-0000-4000-8000-000000000006'

  await applyDashboardDelta(
    fake.context,
    layoutDelta(mutationId),
    { authorType: 'agent', runId },
  )

  assert.equal(fake.persistedDeltas()[0]?.runId, runId)
  assert.equal(fake.persistedVersions()[0]?.runId, runId)
})

test('dashboard deltas are atomic, replayable, and reject stale writers', async () => {
  const fake = createContext()
  const first = await applyDashboardDelta(fake.context, layoutDelta(mutationId))

  assert.deepEqual(first, {
    dashboard: {
      id: dashboardId,
      layout: { lg: [], md: [], sm: [] },
      presentation: { attributions: [], filters: [], insights: [], style: 'standard' },
      revision: 3,
    },
    replayed: false,
  })
  assert.equal(fake.updateClaims(), 1)

  const replay = await applyDashboardDelta(fake.context, layoutDelta(mutationId))
  assert.equal(replay.replayed, true)
  assert.equal(replay.dashboard.revision, 3)
  assert.equal(fake.updateClaims(), 1)

  await assert.rejects(
    () => applyDashboardDelta(
      fake.context,
      layoutDelta('00000000-0000-4000-8000-000000000005'),
    ),
    (error: unknown) => error instanceof DashboardRevisionConflictError && error.currentRevision === 3,
  )
  assert.equal(fake.updateClaims(), 1)
})

test('dashboard delta replay rejects reused mutation ids with different edits', async () => {
  const fake = createContext()

  await applyDashboardDelta(fake.context, layoutDelta(mutationId))

  await assert.rejects(
    () => applyDashboardDelta(fake.context, {
      ...layoutDelta(mutationId),
      operations: [{
        presentation: { attributions: [], filters: [], insights: [], style: 'executive' as const },
        type: 'set_presentation' as const,
      }],
    }),
    /already used for a different edit/,
  )
  assert.equal(fake.updateClaims(), 1)
})
