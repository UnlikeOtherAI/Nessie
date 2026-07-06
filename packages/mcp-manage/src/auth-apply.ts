import {
  McpServerAuthConfigSchema,
  type McpTransportConfig,
} from '@nessie/schemas'

/**
 * Apply a resolved plaintext credential to an MCP transport according to the
 * catalog entry's auth config. One implementation shared by the API-side probe
 * (`resolveProbeTransport`) and the worker's MCP toolset so the two can never
 * disagree about how a credential becomes a header.
 *
 * - `bearer` / `oauth2` → `Authorization: Bearer <secret>` (OAuth access
 *   tokens are bearer tokens per RFC 6750).
 * - `api_key` → the configured header name with the configured value prefix.
 * - `none` / `basic` / unparseable config → transport unchanged (`basic` is
 *   not yet supported end-to-end; a missing header fails loudly at the server
 *   rather than sending a mis-formatted one).
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
  return transport
}
