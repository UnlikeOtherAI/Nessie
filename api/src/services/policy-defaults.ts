import type { PolicyAction, PolicyEffect, PolicyResourceType } from '@nessie/schemas'

// Which access rules every organisation starts with, and which of them come
// back on their own. Data only: `policy-seed.ts` writes these, and
// `policy-rules.ts` reads `defaultPolicyRuleKind` to refuse deleting the ones
// nothing would restore.

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
 * What a rule is, by its `seedKey`: a default reconcile writes back on every
 * deploy (`'restored'`), a default written once for a new organisation and never
 * again (`'protected'`), or not a default at all (`null`).
 *
 * A protected default cannot be deleted, nor its binding removed
 * (plan §9, "block deleting seeded rules that do not self-heal"): these are the
 * rules that let every member see channels and agents, use tools, and keep
 * administration to owners, and deleting one took effect at once for every
 * member with nothing to bring it back. Deleting a restored default is allowed;
 * it returns with the next reconcile, which the Access rules page says.
 */
export const defaultPolicyRuleKind = (
  seedKey: string | null,
): 'protected' | 'restored' | null => {
  if (seedKey === null) return null
  if (SELF_HEALING_DEFAULT_POLICIES.some((rule) => rule.seedKey === seedKey)) return 'restored'
  if (NEW_ORGANIZATION_DEFAULT_POLICIES.some((rule) => rule.seedKey === seedKey)) return 'protected'
  return null
}
