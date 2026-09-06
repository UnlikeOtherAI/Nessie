import type { PrismaClient } from '@prisma/client'
import type { PolicyAction, PolicyEffect, PolicyResourceType } from '@nessie/schemas'

import { actionToPrisma, createPolicyRule } from './policy-rules.js'

// Default-policy seeding: run once at bootstrap (`db/seed.ts`) and self-healed
// for every pre-existing organization at login (`team-context.ts`) and at API
// startup (`index.ts`). Idempotent — each `ensure*` checks for an existing
// matching rule before creating one. Evaluation lives in `policy.ts`; rule
// CRUD lives in `policy-rules.ts`.

const ensureAgentBindDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
): Promise<void> => {
  const ensureRule = async (input: {
    actorId: string
    effect: PolicyEffect
    priority: number
  }) => {
    const existingRule = await prisma.policyRule.findFirst({
      where: {
        action: actionToPrisma('bind') as 'bind',
        bindings: {
          some: {
            actorId: input.actorId,
            actorType: 'role',
          },
        },
        effect: input.effect,
        organizationId,
        resourceType: 'agent',
        scope: 'organization',
        scopeId: organizationId,
      },
      select: { id: true },
    })

    if (existingRule) {
      return
    }

    await createPolicyRule(prisma, {
      organizationId,
      scope: 'organization',
      scopeId: organizationId,
      resourceType: 'agent',
      action: 'bind',
      effect: input.effect,
      priority: input.priority,
      createdBy,
      bindings: [{ actorType: 'role', actorId: input.actorId }],
    })
  }

  await ensureRule({ actorId: 'member', effect: 'deny', priority: 50 })
  await ensureRule({ actorId: 'owner', effect: 'allow', priority: 10 })
}

// The original default rule set had no knowledge_space / knowledge_page rules,
// which left every knowledge action denied (deny-by-default). Grant org members
// the authoring actions so the knowledge base is usable; reserve approve for
// owners. Fine-grained per-space privacy is enforced separately in the knowledge
// provider, not here. Idempotent so it also backfills existing organizations on
// startup.
const ensureKnowledgeDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
): Promise<void> => {
  const ensure = async (
    resourceType: PolicyResourceType,
    action: PolicyAction,
    actorId: string,
    priority: number,
  ) => {
    const existingRule = await prisma.policyRule.findFirst({
      where: {
        action: actionToPrisma(action) as Exclude<PolicyAction, 'export' | 'import'>,
        bindings: { some: { actorId, actorType: 'role' } },
        effect: 'allow',
        organizationId,
        resourceType,
        scope: 'organization',
        scopeId: organizationId,
      },
      select: { id: true },
    })
    if (existingRule) return
    await createPolicyRule(prisma, {
      organizationId,
      scope: 'organization',
      scopeId: organizationId,
      resourceType,
      action,
      effect: 'allow',
      priority,
      createdBy,
      bindings: [{ actorType: 'role', actorId }],
    })
  }

  for (const action of ['view', 'create', 'edit'] as const) {
    await ensure('knowledge_space', action, '*', 100)
  }
  for (const action of ['view', 'create', 'edit', 'read', 'search'] as const) {
    await ensure('knowledge_page', action, '*', 100)
  }
  await ensure('knowledge_page', 'approve', 'owner', 10)
}

export const seedDefaultPolicies = async (
  prisma: Pick<PrismaClient, 'policyRule'>,
  organizationId: string,
  createdBy: string,
) => {
  const existing = await prisma.policyRule.count({ where: { organizationId } })
  await ensureKnowledgeDefaultPolicies(prisma, organizationId, createdBy)
  if (existing > 0) {
    await ensureAgentBindDefaultPolicies(prisma, organizationId, createdBy)
    return
  }

  // Allow org members to view public channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'channel',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  // Deny non-admins from admin actions
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'admin',
    action: 'admin',
    effect: 'deny',
    priority: 50,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'member' }],
  })

  // Allow admins all admin actions
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'admin',
    action: 'admin',
    effect: 'allow',
    priority: 10,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'owner' }],
  })

  // Allow project members to view/invoke agents
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'invoke',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })

  // Deny regular members from binding agents to channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'bind',
    effect: 'deny',
    priority: 50,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'member' }],
  })

  // Allow owners to bind agents to channels
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'agent',
    action: 'bind',
    effect: 'allow',
    priority: 10,
    createdBy,
    bindings: [{ actorType: 'role', actorId: 'owner' }],
  })

  // Allow viewing tools
  await createPolicyRule(prisma, {
    organizationId,
    scope: 'organization',
    scopeId: organizationId,
    resourceType: 'tool',
    action: 'view',
    effect: 'allow',
    priority: 100,
    createdBy,
    bindings: [{ actorType: 'role', actorId: '*' }],
  })
}
