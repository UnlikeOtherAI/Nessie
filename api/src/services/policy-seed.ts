import { Prisma, type PrismaClient } from '@prisma/client'
import type { PolicyAction } from '@nessie/schemas'

import { actionToPrisma } from './policy-rules.js'
import {
  type DefaultPolicyRule,
  NEW_ORGANIZATION_DEFAULT_POLICIES,
  SELF_HEALING_DEFAULT_POLICIES,
} from './policy-defaults.js'

// Default-policy seeding: run at bootstrap (`db/seed.ts`), for a freshly
// materialized organisation on the login path (`team-context.ts`,
// `team-principal.ts`), and once per deploy from
// `pnpm --filter @nessie/api reconcile` — never on every API replica's startup
// path (docs/standards/horizontal-scaling/overview.md §5). Idempotent and race-free:
// each rule carries a stable `seedKey` constrained by a partial unique index,
// so N concurrent callers for one organisation converge on one default set.
// Evaluation lives in `policy.ts`; rule CRUD lives in `policy-rules.ts`; the
// default rules themselves are `policy-defaults.ts`.

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
 * replica's startup path, per docs/standards/horizontal-scaling/overview.md §5.
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
