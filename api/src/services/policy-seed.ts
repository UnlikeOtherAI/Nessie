import { Prisma, type PrismaClient } from '@prisma/client'
import type { PolicyAction, PolicyEffect, PolicyResourceType } from '@nessie/schemas'

import { actionToPrisma } from './policy-rules.js'

// Default-policy seeding: run at bootstrap (`db/seed.ts`), for a freshly
// materialized organisation on the login path (`team-context.ts`,
// `team-principal.ts`), and once per deploy from
// `pnpm --filter @nessie/api reconcile` — never on every API replica's startup
// path (docs/standards/horizontal-scaling.md §5). Idempotent and race-free:
// each rule carries a stable `seedKey` constrained by a partial unique index,
// so N concurrent callers for one organisation converge on one default set.
// Evaluation lives in `policy.ts`; rule CRUD lives in `policy-rules.ts`.

/**
 * One default rule, identified by a stable `seedKey`. The key — not the rule's
 * semantic columns — is what the partial unique index
 * `policy_rules_organization_id_seed_key_key` constrains, because a person may
 * legitimately author two rules that differ only in `conditions` or `priority`
 * and a semantic unique index would refuse the second one.
 */
export type DefaultPolicyRule = {
  /** The role the rule binds to; `*` is every role. */
  actorId: string
  action: PolicyAction
  effect: PolicyEffect
  priority: number
  resourceType: PolicyResourceType
  seedKey: string
}

const defaultRule = (
  resourceType: PolicyResourceType,
  action: PolicyAction,
  effect: PolicyEffect,
  actorId: string,
  priority: number,
): DefaultPolicyRule => ({
  actorId,
  action,
  effect,
  priority,
  resourceType,
  seedKey: `default:${resourceType}:${action}:${effect}:${actorId}`,
})

/**
 * Re-asserted for every organisation on every reconcile. The knowledge rules
 * were added after the original default set and the agent-bind pair after that,
 * so an organisation provisioned by an older release is missing them and denies
 * knowledge actions and every agent bind by default until they are backfilled.
 * Fine-grained per-space knowledge privacy is enforced in the knowledge
 * provider, not here.
 */
export const SELF_HEALING_DEFAULT_POLICIES: readonly DefaultPolicyRule[] = [
  defaultRule('knowledge_space', 'view', 'allow', '*', 100),
  defaultRule('knowledge_space', 'create', 'allow', '*', 100),
  defaultRule('knowledge_space', 'edit', 'allow', '*', 100),
  defaultRule('knowledge_page', 'view', 'allow', '*', 100),
  defaultRule('knowledge_page', 'create', 'allow', '*', 100),
  defaultRule('knowledge_page', 'edit', 'allow', '*', 100),
  defaultRule('knowledge_page', 'read', 'allow', '*', 100),
  defaultRule('knowledge_page', 'search', 'allow', '*', 100),
  defaultRule('knowledge_page', 'approve', 'allow', 'owner', 10),
  defaultRule('agent', 'bind', 'deny', 'member', 50),
  defaultRule('agent', 'bind', 'allow', 'owner', 10),
]

/**
 * Written once, when an organisation has no policy rules at all. The extra
 * rules here are deliberately NOT re-asserted afterwards: an owner who deleted
 * "every role may view channels" meant it, and resurrecting it on each deploy
 * would silently widen access.
 */
export const NEW_ORGANIZATION_DEFAULT_POLICIES: readonly DefaultPolicyRule[] = [
  ...SELF_HEALING_DEFAULT_POLICIES,
  defaultRule('channel', 'view', 'allow', '*', 100),
  defaultRule('admin', 'admin', 'deny', 'member', 50),
  defaultRule('admin', 'admin', 'allow', 'owner', 10),
  defaultRule('agent', 'view', 'allow', '*', 100),
  defaultRule('agent', 'invoke', 'allow', '*', 100),
  defaultRule('tool', 'view', 'allow', '*', 100),
]

/**
 * Enough of Prisma for the seed: the two delegates it writes, and raw SQL for
 * the advisory lock. A `Prisma.TransactionClient` satisfies it, which is how the
 * login path passes the transaction it already holds.
 */
export type PolicySeedClient =
  Pick<PrismaClient, '$queryRaw' | 'policyBinding' | 'policyRule'>

export type PolicySeedResult = { bindingsCreated: number; rulesCreated: number }

/**
 * Serialise everything that writes one organisation's defaults — the login path
 * (`ensureTeamPrincipal`, which already runs inside a transaction under
 * `lockExternalOrganization`) and the reconcile job — on one transaction-scoped
 * advisory lock. The lock is the optimisation; the partial unique index on
 * `(organization_id, seed_key)` is the guarantee, so a caller outside a
 * transaction still cannot duplicate a default.
 */
const lockPolicySeed = (
  tx: Pick<PrismaClient, '$queryRaw'>,
  organizationId: string,
): Prisma.PrismaPromise<unknown> => tx.$queryRaw(Prisma.sql`
  SELECT 1
  FROM (
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`policy-seed:${organizationId}`}, 0)
    )
  ) AS acquired
`)

const writeDefaultPolicies = async (
  tx: PolicySeedClient,
  organizationId: string,
  createdBy: string,
  rules: readonly DefaultPolicyRule[],
): Promise<PolicySeedResult> => {
  const { count: rulesCreated } = await tx.policyRule.createMany({
    data: rules.map((rule) => ({
      action: actionToPrisma(rule.action) as Exclude<PolicyAction, 'export' | 'import'>,
      createdBy,
      effect: rule.effect,
      organizationId,
      priority: rule.priority,
      resourceType: rule.resourceType,
      scope: 'organization' as const,
      scopeId: organizationId,
      seedKey: rule.seedKey,
    })),
    skipDuplicates: true,
  })

  // `createMany` cannot write the nested binding, so the actor edge is a second
  // pass resolved through the seed key. `PolicyBinding` is unique on
  // (policy_rule_id, actor_type, actor_id), so this is idempotent as well and a
  // boot that crashed between the two statements is repaired by the next run.
  const seeded = await tx.policyRule.findMany({
    select: { id: true, seedKey: true },
    where: { organizationId, seedKey: { in: rules.map((rule) => rule.seedKey) } },
  })
  const actorBySeedKey = new Map(rules.map((rule) => [rule.seedKey, rule.actorId]))
  const { count: bindingsCreated } = await tx.policyBinding.createMany({
    data: seeded.flatMap((rule) => {
      const actorId = rule.seedKey === null ? undefined : actorBySeedKey.get(rule.seedKey)
      return actorId === undefined
        ? []
        : [{ actorId, actorType: 'role', policyRuleId: rule.id }]
    }),
    skipDuplicates: true,
  })

  return { bindingsCreated, rulesCreated }
}

/**
 * Idempotent and race-free: N concurrent callers for one organisation produce
 * exactly one default set. Runs from `pnpm --filter @nessie/api reconcile` after
 * `migrate deploy` (and, in `local` mode only, at boot) — never on every API
 * replica's startup path, per docs/standards/horizontal-scaling.md §5.
 */
export const seedDefaultPolicies = async (
  tx: PolicySeedClient,
  organizationId: string,
  createdBy: string,
): Promise<PolicySeedResult> => {
  await lockPolicySeed(tx, organizationId)
  // Deliberately scope-agnostic: this counts policy rules of ANY scope in the
  // organisation, not only the organisation-scoped ones the defaults occupy.
  // That is the pre-existing semantics — "has anybody ever written a rule
  // here?" — and it is not a bug to be fixed: narrowing it to
  // `scope: 'organization'` would change behaviour, because an organisation
  // whose only rules are team- or project-scoped would then read as brand new
  // and have the NEW_ORGANIZATION extras written back into it.
  const existing = await tx.policyRule.count({ where: { organizationId } })
  return writeDefaultPolicies(
    tx,
    organizationId,
    createdBy,
    existing === 0 ? NEW_ORGANIZATION_DEFAULT_POLICIES : SELF_HEALING_DEFAULT_POLICIES,
  )
}
