import type { McpServerAuthConfig } from '@nessie/schemas'
import type { McpCatalogAuthMethod } from '@prisma/client'

import type { RegistryRemote } from './registry-schema.js'

/**
 * Which credential an ingested server expects, read from the header metadata
 * its publisher declared on the remote.
 *
 * A required *secret* `Authorization` header whose sample value starts with
 * `Bearer` is `bearer`; any other required secret header is `api_key` carrying
 * that header's real name (not a guessed `Authorization`, which would send the
 * key somewhere the server does not read). Everything else is `none`.
 *
 * The registry schema cannot express OAuth at all, so a server that actually
 * wants OAuth classifies as `none` here and announces itself with a 401 at
 * install time. That is the honest signal; inventing an OAuth config from
 * nothing would produce a connector that fails later and less clearly.
 *
 * **`library.ts` holds a private near-copy of this** (`classifyRemoteAuth`),
 * written for the install picker before ingestion existed. This module is the
 * shared version; the library's copy should be deleted in favour of it — that
 * edit belongs to whoever owns `library.ts`, so the duplication is named here
 * rather than left to be discovered.
 */

export type RegistryRemoteAuth = {
  authMethod: McpCatalogAuthMethod
  authConfig: McpServerAuthConfig
}

export const classifyRegistryRemoteAuth = (
  remote: RegistryRemote,
): RegistryRemoteAuth => {
  const secretHeaders = (remote.headers ?? []).filter(
    (header) => header.isSecret && header.isRequired,
  )
  if (secretHeaders.length === 0) {
    return { authMethod: 'none', authConfig: { method: 'none' } }
  }

  const authorization = secretHeaders.find(
    (header) => header.name.toLowerCase() === 'authorization',
  )
  if (authorization && (authorization.value ?? '').toLowerCase().startsWith('bearer')) {
    return { authMethod: 'bearer', authConfig: { method: 'bearer' } }
  }

  const first = secretHeaders[0]
  return {
    authMethod: 'api_key',
    authConfig: {
      method: 'api_key',
      headerName: first?.name ?? 'Authorization',
      valuePrefix: '',
    },
  }
}
