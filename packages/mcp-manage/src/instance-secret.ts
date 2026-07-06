import type { PrismaClient } from '@prisma/client'

import { upsertOverride } from './mcp-credentials.js'
import {
  canManageInstanceScope,
  type McpInstanceRow,
  type McpUserAccess,
} from './mcp-instances.js'
import type { SecretStore } from './mcp-oauth.js'

/**
 * Store a user-provided connector credential (API key / token) and attach it
 * to an instance. One implementation shared by the personal assistant's
 * `connector_set_secret` tool and the admin UI's instance-secret route so the
 * placement rules can never drift:
 *
 * - the user's own user-scope instance → the instance's connection credential;
 * - a shared instance with `shared: true` and manage rights → the shared
 *   default credential for everyone;
 * - otherwise → a per-user credential override on the shared instance.
 *
 * The plaintext is handed straight to the encrypted {@link SecretStore} and
 * never returned; callers only see the placement that was chosen.
 */
export type StoreInstanceSecretResult = {
  placement: 'instance' | 'shared_default' | 'user_override'
  credentialRef: string
}

export const storeInstanceSecret = async (
  prisma: PrismaClient,
  secretStore: SecretStore,
  input: {
    instance: Pick<McpInstanceRow, 'id' | 'scopeType' | 'scopeId'>
    userId: string
    access: Pick<McpUserAccess, 'role'>
    secret: string
    shared?: boolean
  },
): Promise<StoreInstanceSecretResult> => {
  const secret = input.secret.trim()
  if (!secret) {
    throw new Error('Secret value must not be empty')
  }
  const ref = await secretStore.put({ accessToken: secret })
  const manageable = canManageInstanceScope(
    input.access,
    input.userId,
    input.instance.scopeType,
    input.instance.scopeId,
  )

  if (input.instance.scopeType === 'user' && input.instance.scopeId === input.userId) {
    await prisma.mcpServerInstance.update({
      where: { id: input.instance.id },
      data: { credentialRef: ref },
    })
    return { placement: 'instance', credentialRef: ref }
  }
  if (input.shared && manageable) {
    await prisma.mcpServerInstance.update({
      where: { id: input.instance.id },
      data: { credentialRef: ref },
    })
    return { placement: 'shared_default', credentialRef: ref }
  }
  await upsertOverride(prisma, {
    instanceId: input.instance.id,
    principalType: 'user',
    principalId: input.userId,
    credentialRef: ref,
  })
  return { placement: 'user_override', credentialRef: ref }
}
