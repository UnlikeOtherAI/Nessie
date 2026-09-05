/**
 * The sole structural mutation path for dashboards.
 *
 * The operation log is deliberately small and closed. It is applied inside one
 * transaction after a conditional revision claim, then recorded beside a full
 * snapshot. A retry with the same mutation id is harmless; a different stale
 * writer gets a conflict before any child row can change.
 */

import type { Prisma } from '@prisma/client'
import {
  DashboardDeltaSchema,
  DashboardLayoutSchema,
  DashboardOutputColumnsSchema,
  DashboardPresentationSchema,
  WidgetDefinitionSchema,
  assertWidgetBinding,
  type DashboardDelta,
  type DashboardWidgetKind,
} from '@nessie/schemas'
import { assertDashboardAccess } from '../access.js'
import {
  DashboardServiceError,
  summarizeChange,
  validateLayout,
  type DashboardContext,
} from './dashboards.js'

export class DashboardRevisionConflictError extends DashboardServiceError {
  constructor(readonly currentRevision: number) {
    super(409, 'DASHBOARD_REVISION_CONFLICT', 'This dashboard changed; reload before applying another edit.')
  }
}

type DeltaResult = {
  dashboard: { id: string; revision: number; layout: unknown; presentation: unknown }
  replayed: boolean
}

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const conflict = (revision: number): never => {
  throw new DashboardRevisionConflictError(revision)
}

const sourceColumns = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  sourceId: string,
) => {
  const source = await tx.dashboardDataSource.findFirst({
    where: { id: sourceId, organizationId, archivedAt: null },
    select: { outputColumns: true },
  })
  if (!source) {
    throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
  }
  const columns = DashboardOutputColumnsSchema.safeParse(source.outputColumns)
  if (!columns.success) {
    throw new DashboardServiceError(409, 'DASHBOARD_SOURCE_INVALID', 'data source columns are invalid')
  }
  return columns.data
}

const assertDefinition = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  value: unknown,
) => {
  const definition = WidgetDefinitionSchema.parse(value)
  try {
    assertWidgetBinding(definition, await sourceColumns(tx, organizationId, definition.sourceId))
  } catch (error) {
    throw new DashboardServiceError(
      400,
      'DASHBOARD_WIDGET_BINDING_INVALID',
      error instanceof Error ? error.message : 'binding does not match source columns',
    )
  }
  return definition
}

const assertPresentation = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  value: unknown,
) => {
  const presentation = DashboardPresentationSchema.parse(value)
  const seenFilters = new Set<string>()
  for (const filter of presentation.filters) {
    if (seenFilters.has(filter.id)) {
      throw new DashboardServiceError(400, 'DASHBOARD_FILTER_DUPLICATE', 'filter ids must be unique')
    }
    seenFilters.add(filter.id)
    const columns = await sourceColumns(tx, organizationId, filter.sourceId)
    if (!columns.some((column) => column.key === filter.column)) {
      throw new DashboardServiceError(400, 'DASHBOARD_FILTER_COLUMN_INVALID', 'filter column is not on its source')
    }
  }
  for (const attribution of presentation.attributions) {
    await sourceColumns(tx, organizationId, attribution.sourceId)
  }
  return presentation
}

const assertMaterialsFitDashboardAudience = async (
  tx: Prisma.TransactionClient,
  dashboard: {
    channelId: string | null
    home: string
    organizationId: string
    ownerUserId: string | null
    projectId: string | null
    teamId: string | null
  },
  sourceIds: string[],
) => {
  const materials = await tx.dashboardSourceMaterial.findMany({
    where: { sourceId: { in: sourceIds }, organizationId: dashboard.organizationId },
    select: { accessBasis: true, sourceId: true },
  })
  const expectedId = dashboard.home === 'organization'
    ? dashboard.organizationId
    : dashboard.home === 'project'
      ? dashboard.projectId
      : dashboard.home === 'team'
        ? dashboard.teamId
        : dashboard.home === 'channel'
          ? dashboard.channelId
          : dashboard.ownerUserId
  const expectedScopeType = dashboard.home === 'personal' ? 'user' : dashboard.home
  for (const material of materials) {
    const basis = Array.isArray(material.accessBasis) ? material.accessBasis : null
    if (!basis || basis.length === 0) {
      throw new DashboardServiceError(
        409,
        'DASHBOARD_SOURCE_AUDIENCE_MISMATCH',
        `source ${material.sourceId} has no verified audience basis`,
      )
    }
    const fits = basis.some((scope) =>
      scope
      && typeof scope === 'object'
      && 'scopeType' in scope
      && 'scopeId' in scope
      && (scope as { scopeType?: unknown }).scopeType === expectedScopeType
      && (scope as { scopeId?: unknown }).scopeId === expectedId,
    ) || basis.some((scope) =>
      scope
      && typeof scope === 'object'
      && (scope as { scopeType?: unknown }).scopeType === 'organization'
      && (scope as { scopeId?: unknown }).scopeId === dashboard.organizationId,
    )
    if (!fits) {
      throw new DashboardServiceError(
        409,
        'DASHBOARD_SOURCE_AUDIENCE_MISMATCH',
        `source ${material.sourceId} cannot be shown to this dashboard audience`,
      )
    }
  }
}

export const applyDashboardDelta = async (
  context: DashboardContext,
  input: unknown,
  options: { authorType: 'user' | 'agent'; runId?: string | null } = { authorType: 'user' },
): Promise<DeltaResult> => {
  const { dashboardId, ...deltaInput } = input as { dashboardId?: string } & Record<string, unknown>
  const delta: DashboardDelta = DashboardDeltaSchema.parse(deltaInput)
  if (typeof dashboardId !== 'string') {
    throw new DashboardServiceError(400, 'DASHBOARD_ID_REQUIRED', 'dashboardId is required')
  }

  await assertDashboardAccess({
    prisma: context.prisma,
    membership: context.membership,
    actor: context.actor,
    resource: { type: 'dashboard', id: dashboardId },
    capability: 'edit',
  })

  if (!('$transaction' in context.prisma)) {
    throw new DashboardServiceError(500, 'DASHBOARD_TRANSACTION_REQUIRED', 'dashboard mutations need a root database client')
  }
  const prisma = context.prisma

  return prisma.$transaction(async (tx) => {
    const replay = await tx.dashboardDelta.findUnique({
      where: { dashboardId_mutationId: { dashboardId, mutationId: delta.mutationId } },
      select: { operations: true, revision: true },
    })
    if (replay) {
      if (canonicalize(replay.operations) !== canonicalize(delta.operations)) {
        throw new DashboardServiceError(
          409,
          'DASHBOARD_MUTATION_ID_REUSED',
          'This dashboard mutation id was already used for a different edit.',
        )
      }
      const dashboard = await tx.dashboard.findFirst({
        where: { id: dashboardId, organizationId: context.actor.organizationId },
        select: { id: true, revision: true, layout: true, presentation: true },
      })
      if (!dashboard) throw new DashboardServiceError(404, 'DASHBOARD_NOT_FOUND', 'dashboard not found')
      return { dashboard, replayed: true }
    }

    const before = await tx.dashboard.findFirst({
      where: { id: dashboardId, organizationId: context.actor.organizationId, archivedAt: null },
      include: { widgets: { orderBy: { createdAt: 'asc' } } },
    })
    if (!before) throw new DashboardServiceError(404, 'DASHBOARD_NOT_FOUND', 'dashboard not found')
    if (before.revision !== delta.baseRevision) conflict(before.revision)

    // Claim this exact revision before touching child rows. All public writers
    // call this function, so a competing writer now observes a stale revision.
    const claimed = await tx.dashboard.updateMany({
      where: { id: dashboardId, revision: delta.baseRevision },
      data: { revision: { increment: 1 } },
    })
    if (claimed.count !== 1) {
      const current = await tx.dashboard.findUnique({ where: { id: dashboardId }, select: { revision: true } })
      conflict(current?.revision ?? delta.baseRevision)
    }

    const widgets = new Map(before.widgets.map((widget) => [widget.id, widget]))
    let layout = DashboardLayoutSchema.parse(before.layout)
    let presentation = DashboardPresentationSchema.parse(before.presentation)
    for (const operation of delta.operations) {
      switch (operation.type) {
        case 'add_widget': {
          if (widgets.has(operation.widgetId)) {
            throw new DashboardServiceError(409, 'DASHBOARD_WIDGET_EXISTS', 'widget id already exists')
          }
          const definition = await assertDefinition(tx, context.actor.organizationId, operation.definition)
          const widget = await tx.dashboardWidget.create({
            data: {
              id: operation.widgetId,
              organizationId: context.actor.organizationId,
              dashboardId,
              sourceId: definition.sourceId,
              kind: definition.kind,
              schemaVersion: definition.schemaVersion,
              spec: definition as unknown as Prisma.InputJsonValue,
            },
          })
          widgets.set(widget.id, widget)
          break
        }
        case 'update_widget': {
          const existing = widgets.get(operation.widgetId)
          if (!existing) throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
          if (existing.lockedAt && options.authorType === 'agent') {
            throw new DashboardServiceError(409, 'DASHBOARD_WIDGET_LOCKED', 'this widget is locked')
          }
          const definition = await assertDefinition(tx, context.actor.organizationId, operation.definition)
          const widget = await tx.dashboardWidget.update({
            where: { id: existing.id },
            data: {
              sourceId: definition.sourceId,
              kind: definition.kind,
              schemaVersion: definition.schemaVersion,
              spec: definition as unknown as Prisma.InputJsonValue,
            },
          })
          widgets.set(widget.id, widget)
          break
        }
        case 'remove_widget': {
          const existing = widgets.get(operation.widgetId)
          if (!existing) throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
          if (existing.lockedAt && options.authorType === 'agent') {
            throw new DashboardServiceError(409, 'DASHBOARD_WIDGET_LOCKED', 'this widget is locked')
          }
          await tx.dashboardWidget.delete({ where: { id: existing.id } })
          widgets.delete(existing.id)
          layout = {
            lg: layout.lg.filter((rect) => rect.widgetId !== existing.id),
            md: layout.md.filter((rect) => rect.widgetId !== existing.id),
            sm: layout.sm.filter((rect) => rect.widgetId !== existing.id),
          }
          break
        }
        case 'set_widget_lock': {
          const existing = widgets.get(operation.widgetId)
          if (!existing) throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
          const widget = await tx.dashboardWidget.update({
            where: { id: existing.id },
            data: { lockedAt: operation.locked ? new Date() : null },
          })
          widgets.set(widget.id, widget)
          break
        }
        case 'set_layout':
          layout = operation.layout
          break
        case 'set_presentation':
          presentation = await assertPresentation(tx, context.actor.organizationId, operation.presentation)
          break
      }
    }

    const kinds = new Map<string, DashboardWidgetKind>(
      [...widgets.values()].map((widget) => [widget.id, widget.kind as DashboardWidgetKind]),
    )
    validateLayout(layout, kinds)
    await assertMaterialsFitDashboardAudience(
      tx,
      before,
      [...widgets.values()].map((widget) => widget.sourceId),
    )
    const revision = delta.baseRevision + 1
    const dashboard = await tx.dashboard.update({
      where: { id: dashboardId },
      data: {
        layout: layout as unknown as Prisma.InputJsonValue,
        presentation: presentation as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, revision: true, layout: true, presentation: true },
    })

    const afterWidgets = [...widgets.values()]
    await tx.dashboardDelta.create({
      data: {
        organizationId: context.actor.organizationId,
        dashboardId,
        mutationId: delta.mutationId,
        baseRevision: delta.baseRevision,
        revision,
        operations: delta.operations as unknown as Prisma.InputJsonValue,
        authorType: options.authorType,
        authorId: context.actor.userId,
        runId: options.runId ?? null,
      },
    })
    await tx.dashboardVersion.create({
      data: {
        organizationId: context.actor.organizationId,
        dashboardId,
        versionNumber: revision,
        layout: layout as unknown as Prisma.InputJsonValue,
        presentation: presentation as unknown as Prisma.InputJsonValue,
        widgets: (afterWidgets.map((widget) => ({
          id: widget.id,
          kind: widget.kind,
          spec: widget.spec,
        })) as unknown as Prisma.InputJsonValue),
        authorType: options.authorType,
        authorId: context.actor.userId,
        runId: options.runId ?? null,
        summary: summarizeChange(
          { widgets: before.widgets, layout: DashboardLayoutSchema.parse(before.layout) },
          { widgets: afterWidgets, layout },
        ),
      },
    })
    return { dashboard, replayed: false }
  })
}
