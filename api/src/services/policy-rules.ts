import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  PolicyAction,
  PolicyEffect,
  PolicyResourceType,
  PolicyScope,
} from '@nessie/schemas'
import { buildPage, decodeKeysetCursor, resolvePageLimit, type PaginationDirection } from '@nessie/schemas'

// Policy rule CRUD: authoring and reading `PolicyRule`/`PolicyBinding` rows.
// Evaluation (`checkPolicy`, `checkPolicyBatch`, `getEffectivePolicy`) lives in
// `policy.ts`; default-policy seeding lives in `policy-seed.ts` and calls back
// into `createPolicyRule` here.

export const actionToPrisma = (action: string) => {
  if (action === 'export') return 'export_action'
  if (action === 'import') return 'import_action'
  return action
}

export const listPolicyRules = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    scope?: PolicyScope
    scopeId?: string
    resourceType?: PolicyResourceType
    cursor?: string
    direction?: PaginationDirection
    limit?: number
  },
) => {
  const limit = resolvePageLimit(filters?.limit)
  const where: Record<string, unknown> = { organizationId }
  if (filters?.scope) where['scope'] = filters.scope
  if (filters?.scopeId) where['scopeId'] = filters.scopeId
  if (filters?.resourceType) where['resourceType'] = filters.resourceType

  // The total is counted against the same filters but before the cursor is
  // applied: "26–50 of 134" has to mean 134 matching records, not 134 records
  // after the one this page starts at.
  const total = await prisma.policyRule.count({ where: where as Prisma.PolicyRuleWhereInput })

  const parsed = decodeKeysetCursor(filters?.cursor)
  const backwards = filters?.direction === 'backward'
  if (parsed) {
    where['OR'] = [
      { createdAt: { [backwards ? 'lt' : 'gt']: parsed.createdAt } },
      { createdAt: parsed.createdAt, id: { [backwards ? 'lt' : 'gt']: parsed.id } },
    ]
  }

  const rules = await prisma.policyRule.findMany({
    where: where as Prisma.PolicyRuleWhereInput,
    include: { bindings: true },
    orderBy: backwards
      ? [{ createdAt: 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  })

  const page = buildPage({
    direction: filters?.direction,
    hasCursor: Boolean(parsed),
    limit,
    rows: rules,
    total,
  })

  return {
    data: page.data.map(mapPolicyRule),
    meta: page.meta,
  }
}

export const createPolicyRule = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  input: {
    organizationId: string
    scope: PolicyScope
    scopeId: string
    resourceType: PolicyResourceType
    action: PolicyAction
    effect: PolicyEffect
    priority?: number
    conditions?: Record<string, unknown>
    createdBy: string
    bindings?: Array<{ actorType: string; actorId: string }>
  },
) => {
  const rule = await prisma.policyRule.create({
    data: {
      organizationId: input.organizationId,
      scope: input.scope,
      scopeId: input.scopeId,
      resourceType: input.resourceType,
      action: actionToPrisma(input.action) as Exclude<typeof input.action, 'export' | 'import'>,
      effect: input.effect,
      priority: input.priority ?? 0,
      conditions: (input.conditions as Prisma.InputJsonValue) ?? undefined,
      createdBy: input.createdBy,
      bindings: input.bindings
        ? {
            create: input.bindings.map((b) => ({
              actorType: b.actorType,
              actorId: b.actorId,
            })),
          }
        : undefined,
    },
    include: { bindings: true },
  })

  return mapPolicyRule(rule)
}

export const updatePolicyRule = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
  input: {
    effect?: PolicyEffect
    priority?: number
    conditions?: Record<string, unknown> | null
  },
) => {
  const rule = await prisma.policyRule.update({
    where: { id: ruleId, organizationId },
    data: {
      effect: input.effect,
      priority: input.priority,
      conditions: input.conditions === null ? undefined : (input.conditions as Prisma.InputJsonValue),
    },
    include: { bindings: true },
  })

  return mapPolicyRule(rule as typeof rule & { bindings: Array<{ id: string; actorType: string; actorId: string }> })
}

export const deletePolicyRule = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
) => {
  await prisma.policyRule.delete({
    where: { id: ruleId, organizationId },
  })
}

export const addPolicyBinding = async (
  prisma: PrismaClient,
  ruleId: string,
  organizationId: string,
  actorType: string,
  actorId: string,
) => {
  // Scope the parent rule to the caller's organization. Without this, an owner of
  // one org could attach a binding to another org's policy rule (cross-tenant
  // write IDOR) by passing a foreign ruleId.
  const rule = await prisma.policyRule.findFirst({
    where: { id: ruleId, organizationId },
    select: { id: true },
  })
  if (!rule) return null

  const binding = await prisma.policyBinding.create({
    data: { policyRuleId: ruleId, actorType, actorId },
  })
  return { id: binding.id, actorType: binding.actorType, actorId: binding.actorId }
}

export const removePolicyBinding = async (
  prisma: PrismaClient,
  bindingId: string,
  organizationId: string,
): Promise<boolean> => {
  // Only delete a binding whose parent rule belongs to the caller's org, so a
  // foreign bindingId cannot be used to mutate another tenant's policy.
  const { count } = await prisma.policyBinding.deleteMany({
    where: { id: bindingId, policyRule: { is: { organizationId } } },
  })
  return count > 0
}

const mapPolicyRule = (rule: {
  id: string
  organizationId: string
  scope: string
  scopeId: string
  resourceType: string
  action: string
  effect: string
  priority: number
  conditions: unknown
  createdBy: string
  createdAt: Date
  updatedAt: Date
  bindings: Array<{ id: string; actorType: string; actorId: string }>
}) => ({
  id: rule.id,
  organizationId: rule.organizationId,
  scope: rule.scope,
  scopeId: rule.scopeId,
  resourceType: rule.resourceType,
  action: rule.action,
  effect: rule.effect,
  priority: rule.priority,
  conditions: rule.conditions as Record<string, unknown> | null,
  createdBy: rule.createdBy,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
  bindings: rule.bindings.map((b) => ({
    id: b.id,
    actorType: b.actorType,
    actorId: b.actorId,
  })),
})
