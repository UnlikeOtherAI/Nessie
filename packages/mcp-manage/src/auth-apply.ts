import {
  McpServerAuthConfigSchema,
  type McpTransportConfig,
  type McpCatalogAuthMethod,
} from '@nessie/schemas'

/**
 * Whether this catalog contract requires a resolved credential to call it.
 * A malformed or mismatched config fails closed: only a validated `none`
 * method is credential-free.
 */
export const mcpAuthRequiresCredential = (
  authMethod: McpCatalogAuthMethod | string,
  authConfig: unknown,
): boolean => {
  const parsed = McpServerAuthConfigSchema.safeParse(authConfig)
  return !parsed.success || parsed.data.method !== 'none' || authMethod !== 'none'
}

/**
 * Shared MCP credentials are deliberately limited to catalog entries whose
 * method *and* parsed config prove that the credential is an API key. Keeping
 * this beside the auth parser lets every write and resolution boundary apply
 * the same fail-closed test to legacy or malformed catalog rows.
 */
export const isValidatedMcpApiKeyAuth = (
  authMethod: McpCatalogAuthMethod | string,
  authConfig: unknown,
): boolean => {
  const parsed = McpServerAuthConfigSchema.safeParse(authConfig)
  return authMethod === 'api_key' && parsed.success && parsed.data.method === 'api_key'
}

/**
 * Apply a resolved plaintext credential to an MCP transport according to the
 * catalog entry's auth config. One implementation shared by the API-side probe
 * (`resolveProbeTransport`) and the worker's MCP toolset so the two can never
 * disagree about how a credential becomes a header.
 *
 * - `bearer` / `oauth2` → `Authorization: Bearer <secret>` (OAuth access
 *   tokens are bearer tokens per RFC 6750).
 * - `api_key` → the configured header name with the configured value prefix.
 * - `basic` → `Authorization: Basic <base64(username:password)>`.
 * - `none` → transport unchanged.
 *
 * stdio transports are never touched (headers do not apply, and cloud-side
 * stdio is disabled anyway).
 */
export const applyAuthSecretToTransport = (
  transport: McpTransportConfig,
  authConfig: unknown,
  secret: string | null,
): McpTransportConfig => {
  if (!secret || transport.transport === 'stdio') return transport
  const parsed = McpServerAuthConfigSchema.safeParse(authConfig)
  // Unparseable/absent auth config historically meant "treat the secret as a
  // bearer token" (the pre-auth-config behaviour) — keep that so existing
  // instances with a bare credentialRef keep working.
  const method = parsed.success ? parsed.data.method : 'bearer'

  if (method === 'bearer' || method === 'oauth2') {
    return {
      ...transport,
      headers: {
        ...(transport.headers ?? {}),
        Authorization: `Bearer ${secret}`,
      },
    }
  }
  if (method === 'api_key' && parsed.success && parsed.data.method === 'api_key') {
    return {
      ...transport,
      headers: {
        ...(transport.headers ?? {}),
        [parsed.data.headerName]: `${parsed.data.valuePrefix}${secret}`,
      },
    }
  }
  if (method === 'basic') {
    return {
      ...transport,
      headers: {
        ...(transport.headers ?? {}),
        Authorization: `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`,
      },
    }
  }
  return transport
}
