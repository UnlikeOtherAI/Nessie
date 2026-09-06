/**
 * The private DM key an external-agent product's per-user conversation is
 * found by.
 *
 * Team-scoped on purpose: switching UOA workspaces gives a person a distinct
 * conversation with the same product, and a legacy team-less channel fails
 * closed rather than being adopted by whichever team is active
 * (docs/standards/mcp-connectors.md → "External-agent products").
 *
 * It lives in the shared package, not beside the channel bootstrap in
 * `api/src/services/external-agent.ts`, because the worker resolves the same
 * channel when it fans a DeepSignal insight out to its recipients.
 */
export const externalAgentDmKey = (
  productSlug: string,
  organizationId: string,
  userId: string,
  externalTeamId: string,
): string => `extagent:${productSlug}:${organizationId}:${userId}:${externalTeamId}`
