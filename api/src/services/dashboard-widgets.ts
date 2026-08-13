/**
 * Widget mutation and the read-time projection.
 *
 * The projection is the only shape a browser ever receives. It is built from a
 * re-validated stored spec plus a re-validated stored dataset, so a row written
 * by an older schema, edited by hand, or restored from history cannot reach a
 * renderer. When validation fails the widget becomes `unsupported` — inert,
 * carrying only server-authored copy — rather than being guessed at.
 */

import type { Prisma } from '@prisma/client'
import {
  DashboardDatasetSchema,
  DASHBOARD_MAX_COMPACT_ROWS,
  WidgetDefinitionSchema,
  assertWidgetBinding,
  type DashboardOutputColumn,
  type DashboardWidgetProjection,
  type WidgetDefinition,
} from '@nessie/schemas'
import { assertDashboardAccess } from '@nessie/dashboard'
import {
  DashboardServiceError,
  readStoredWidgetSpec,
  type DashboardContext,
} from './dashboards.js'

/** Beyond twice its interval a scheduled source is stale; manual sources at 24h. */
const STALE_AFTER_MANUAL_MS = 24 * 60 * 60 * 1000
const MIN_STALE_MS = 15 * 60 * 1000
const MAX_STALE_MS = 48 * 60 * 60 * 1000

export const isStale = (input: {
  lastValidatedAt: Date | null
  refreshMode: string
  intervalMinutes: number | null
  now?: Date
}): boolean => {
  if (!input.lastValidatedAt) return true
  const now = (input.now ?? new Date()).getTime()
  const age = now - input.lastValidatedAt.getTime()
  if (input.refreshMode !== 'interval' || !input.intervalMinutes) {
    return age > STALE_AFTER_MANUAL_MS
  }
  const window = Math.min(
    MAX_STALE_MS,
    Math.max(MIN_STALE_MS, input.intervalMinutes * 60 * 1000 * 2),
  )
  return age > window
}

export const addWidget = async (
  context: DashboardContext,
  input: { dashboardId: string; definition: unknown },
) => {
  const { prisma, actor } = context
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'dashboard', id: input.dashboardId },
    capability: 'edit',
  })

  const definition = WidgetDefinitionSchema.parse(input.definition)

  const source = await prisma.dashboardDataSource.findFirst({
    where: {
      id: definition.sourceId,
      organizationId: actor.organizationId,
      archivedAt: null,
    },
    select: { id: true, outputColumns: true },
  })
  if (!source) {
    throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
  }

  // A widget may only name fields its source declares — checked here as well as
  // at read time, because the source's columns can change under a stored widget.
  assertWidgetBinding(definition, source.outputColumns as unknown as DashboardOutputColumn[])

  return prisma.dashboardWidget.create({
    data: {
      organizationId: actor.organizationId,
      dashboardId: input.dashboardId,
      sourceId: definition.sourceId,
      kind: definition.kind,
      schemaVersion: definition.schemaVersion,
      spec: definition as unknown as Prisma.InputJsonValue,
    },
  })
}

export const updateWidget = async (
  context: DashboardContext,
  input: { widgetId: string; definition: unknown; byAgent: boolean },
) => {
  const { prisma, actor } = context
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'widget', id: input.widgetId },
    capability: 'edit',
  })

  const existing = await prisma.dashboardWidget.findFirst({
    where: { id: input.widgetId, organizationId: actor.organizationId },
    select: { id: true, lockedAt: true, dashboardId: true },
  })
  if (!existing) {
    throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
  }

  // A lock is enforced here, not by asking a model to respect it.
  if (existing.lockedAt && input.byAgent) {
    throw new DashboardServiceError(
      409,
      'DASHBOARD_WIDGET_LOCKED',
      'this widget is locked; a person can unlock it on the dashboard',
    )
  }

  const definition = WidgetDefinitionSchema.parse(input.definition)
  const source = await prisma.dashboardDataSource.findFirst({
    where: { id: definition.sourceId, organizationId: actor.organizationId, archivedAt: null },
    select: { outputColumns: true },
  })
  if (!source) {
    throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
  }
  assertWidgetBinding(definition, source.outputColumns as unknown as DashboardOutputColumn[])

  return prisma.dashboardWidget.update({
    where: { id: existing.id },
    data: {
      sourceId: definition.sourceId,
      kind: definition.kind,
      schemaVersion: definition.schemaVersion,
      spec: definition as unknown as Prisma.InputJsonValue,
    },
  })
}

export const removeWidget = async (
  context: DashboardContext,
  input: { widgetId: string; byAgent: boolean },
) => {
  const { prisma, actor } = context
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'widget', id: input.widgetId },
    capability: 'edit',
  })

  const existing = await prisma.dashboardWidget.findFirst({
    where: { id: input.widgetId, organizationId: actor.organizationId },
    select: { id: true, lockedAt: true },
  })
  if (!existing) {
    throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
  }
  if (existing.lockedAt && input.byAgent) {
    throw new DashboardServiceError(409, 'DASHBOARD_WIDGET_LOCKED', 'this widget is locked')
  }

  await prisma.dashboardWidget.delete({ where: { id: existing.id } })
}

export const setWidgetLock = async (
  context: DashboardContext,
  input: { widgetId: string; locked: boolean },
) => {
  const { prisma, actor } = context
  await assertDashboardAccess({
    prisma,
    membership: context.membership,
    actor,
    resource: { type: 'widget', id: input.widgetId },
    capability: 'edit',
  })
  return prisma.dashboardWidget.update({
    where: { id: input.widgetId },
    data: { lockedAt: input.locked ? new Date() : null },
  })
}

export type ProjectionOptions = {
  /** Compact surfaces (message, knowledge page) cap rows harder than a canvas. */
  compact?: boolean
  now?: Date
}

type DatasetLoader = (attachmentId: string) => Promise<unknown>

/**
 * Builds what the browser renders.
 *
 * Every branch that cannot produce trustworthy data returns a state rather than
 * partial output: an unparseable spec is `unsupported`, a spec whose binding no
 * longer matches its source is `unsupported`, a source that has never validated
 * is `loading`, an empty result is `empty` (a success, not an error).
 */
export const buildWidgetProjection = async (
  input: {
    widget: {
      id: string
      dashboardId: string
      kind: string
      schemaVersion: number
      spec: unknown
    }
    source: {
      outputColumns: unknown
      latestDatasetId: string | null
      lastValidatedAt: Date | null
      lastErrorCode: string | null
      refreshMode: string
      intervalMinutes: number | null
      authorityLabel?: string | null
    }
    dataset?: { attachmentId: string; fetchedAt: Date } | null
    loadDataset?: DatasetLoader
  },
  options: ProjectionOptions = {},
): Promise<DashboardWidgetProjection> => {
  const base = {
    widgetId: input.widget.id,
    dashboardId: input.widget.dashboardId,
    kind: input.widget.kind as DashboardWidgetProjection['kind'],
    schemaVersion: input.widget.schemaVersion,
    ...(input.source.authorityLabel ? { authorityLabel: input.source.authorityLabel } : {}),
  }

  const definition = readStoredWidgetSpec(input.widget.spec)
  if (!definition) {
    return { ...base, state: 'unsupported' }
  }

  const columns = input.source.outputColumns as DashboardOutputColumn[]
  try {
    assertWidgetBinding(definition, columns)
  } catch {
    // The source's declared columns changed under a stored widget. Render
    // nothing rather than a chart of missing fields.
    return { ...base, definition, state: 'unsupported' }
  }

  if (!input.dataset || !input.source.latestDatasetId || !input.loadDataset) {
    return {
      ...base,
      definition,
      state: input.source.lastErrorCode ? 'error' : 'loading',
      ...(input.source.lastErrorCode ? { errorCode: input.source.lastErrorCode } : {}),
    }
  }

  let dataset
  try {
    const raw = await input.loadDataset(input.dataset.attachmentId)
    dataset = DashboardDatasetSchema.parse(raw)
  } catch {
    return { ...base, definition, state: 'error', errorCode: 'DATASET_UNREADABLE' }
  }

  if (options.compact && dataset.rows.length > DASHBOARD_MAX_COMPACT_ROWS) {
    dataset = { ...dataset, rows: dataset.rows.slice(0, DASHBOARD_MAX_COMPACT_ROWS) }
  }

  const stale = isStale({
    lastValidatedAt: input.source.lastValidatedAt,
    refreshMode: input.source.refreshMode,
    intervalMinutes: input.source.intervalMinutes,
    ...(options.now ? { now: options.now } : {}),
  })

  const state = dataset.rows.length === 0 ? 'empty' : stale ? 'stale' : 'fresh'

  return {
    ...base,
    definition,
    dataset,
    state,
    fetchedAt: dataset.fetchedAt,
    // A failed latest refresh is surfaced alongside the last good data, so a
    // viewer sees numbers AND the fact that they did not just refresh.
    ...(input.source.lastErrorCode ? { errorCode: input.source.lastErrorCode } : {}),
  }
}

export const loadWidgetProjection = async (
  context: DashboardContext,
  input: { widgetId: string; loadDataset: DatasetLoader },
  options: ProjectionOptions = {},
): Promise<DashboardWidgetProjection> => {
  await assertDashboardAccess({
    prisma: context.prisma,
    membership: context.membership,
    actor: context.actor,
    resource: { type: 'widget', id: input.widgetId },
    capability: 'view',
  })

  const widget = await context.prisma.dashboardWidget.findFirst({
    where: { id: input.widgetId, organizationId: context.actor.organizationId },
    include: { source: true },
  })
  if (!widget) {
    throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
  }

  const dataset = widget.source.latestDatasetId
    ? await context.prisma.dashboardDataset.findFirst({
      where: {
        id: widget.source.latestDatasetId,
        organizationId: context.actor.organizationId,
      },
      select: { attachmentId: true, fetchedAt: true },
    })
    : null

  return buildWidgetProjection(
    { widget, source: widget.source, dataset, loadDataset: input.loadDataset },
    options,
  )
}

export type { WidgetDefinition }
