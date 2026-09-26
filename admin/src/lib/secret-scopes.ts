import type { SecretScopeType } from '@nessie/schemas'

/**
 * Whether the viewer may save a secret at `scope`: anyone at `personal`, and
 * only an organisation owner at any level above it.
 *
 * The render gate for `canManageSecretScope`
 * (`api/src/services/secret-vault-write.ts`), which stays the authority. A
 * form draws no scope whose save that would refuse with
 * `403 SECRET_SCOPE_DENIED`. An organisation admin is refused too, so callers
 * answer `viewerIsOwner` with `useIsOwner`, never `useIsOrganizationAdmin`.
 */
export const secretScopeWritable = (
  scope: SecretScopeType,
  { viewerIsOwner }: { viewerIsOwner: boolean },
): boolean => scope === 'personal' || viewerIsOwner
