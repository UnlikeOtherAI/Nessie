import { Prisma, type PrismaClient } from '@prisma/client'
import {
  buildPage,
  decodeKeysetCursor,
  resolvePageLimit,
  type PaginationDirection,
} from '@nessie/schemas'

export type WorkflowTemplateListInput = {
  cursor?: string
  direction?: PaginationDirection
  limit?: number
}

/**
 * The list behind Admin's workflow picker and the PA's workflow_list tool.
 * It deliberately scopes only by organization: authoring is role-gated by its
 * callers, never accidentally narrowed by a session project or team.
 */
export const listWorkflowTemplatesForOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
  input: WorkflowTemplateListInput = {},
) => {
  const limit = resolvePageLimit(input.limit)
  const where: Prisma.WorkflowTemplateWhereInput = { organizationId }
  const total = await prisma.workflowTemplate.count({ where })
  const cursor = decodeKeysetCursor(input.cursor)
  const backwards = input.direction === 'backward'
  if (cursor) {
    where.OR = [
      { createdAt: { [backwards ? 'gt' : 'lt']: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { [backwards ? 'gt' : 'lt']: cursor.id } },
    ]
  }

  const templates = await prisma.workflowTemplate.findMany({
    where,
    orderBy: backwards
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      adoptedAt: true,
      bindingSchema: true,
      createdAt: true,
      createdByActorId: true,
      createdByActorType: true,
      demonstrationId: true,
      description: true,
      graphJson: true,
      id: true,
      name: true,
      organizationId: true,
      requiredEnvironmentTemplateIds: true,
      source: true,
      triggersJson: true,
      updatedAt: true,
      variableSchema: true,
      version: true,
    },
  })
  const page = buildPage({ direction: input.direction, hasCursor: Boolean(cursor), limit, rows: templates, total })
  const templateIds = page.data.map((template) => template.id)
  const installationCounts = templateIds.length === 0
    ? []
    : await prisma.workflowInstallation.groupBy({
      by: ['workflowTemplateId', 'status'],
      where: { organizationId, workflowTemplateId: { in: templateIds } },
      _count: { _all: true },
    })
  const summaries = new Map<string, { active: number; total: number }>()
  for (const row of installationCounts) {
    const summary = summaries.get(row.workflowTemplateId) ?? { active: 0, total: 0 }
    summary.total += row._count._all
    if (row.status === 'active') summary.active += row._count._all
    summaries.set(row.workflowTemplateId, summary)
  }

  return {
    data: page.data.map((template) => ({
      installationSummary: summaries.get(template.id) ?? { active: 0, total: 0 },
      template,
    })),
    meta: page.meta,
  }
}
