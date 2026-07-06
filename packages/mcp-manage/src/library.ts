import { z } from 'zod'

/**
 * Public MCP server library (plan: admin "Library" tab + personal-assistant
 * `connector_library_search` tool).
 *
 * Two sources, one result shape:
 *
 * 1. **Curated list** — a hand-maintained set of well-known, officially hosted
 *    remote MCP servers (the "ChatGPT connector directory" experience). Only
 *    entries whose auth story works with Nessie's connector auth methods
 *    (`none` / `bearer` / `api_key`) are listed, so every curated entry can be
 *    installed end-to-end without manual OAuth-client registration.
 * 2. **Official MCP registry** — `registry.modelcontextprotocol.io`, searched
 *    live. Results are filtered to HTTP/SSE remotes only (Nessie forbids
 *    cloud-side stdio execution) and mapped to the same shape.
 *
 * This module is transport-only (fetch + mapping). Importing an entry into an
 * organisation's catalog happens in the API/worker layer via
 * `libraryEntryToCatalogInput`.
 */

export type McpLibraryTransport = 'http' | 'sse'
export type McpLibraryAuthMethod = 'none' | 'bearer' | 'api_key'

export type McpLibraryEntry = {
  source: 'curated' | 'registry'
  /** Stable identity within its source (curated slug or registry server name). */
  key: string
  /** Machine name used for the imported catalog entry. */
  name: string
  label: string
  description: string
  vendor: string | null
  /** Homepage / repository, for humans. */
  sourceUrl: string | null
  /** Remote MCP endpoint. */
  url: string
  transport: McpLibraryTransport
  authMethod: McpLibraryAuthMethod
  /** Human guidance for the credential this server expects, if any. */
  authHint: string | null
}

/**
 * Curated well-known remote servers. Endpoints are the vendors' officially
 * documented remote MCP URLs. Keep this list small, remote-only, and limited
 * to auth methods a Nessie connector can express today — OAuth-only servers
 * (Notion, Linear, Atlassian, …) are reachable through the registry search
 * instead and need an admin-configured OAuth client.
 */
export const CURATED_MCP_LIBRARY: McpLibraryEntry[] = [
  {
    source: 'curated',
    key: 'deepwiki',
    name: 'deepwiki',
    label: 'DeepWiki',
    description: 'Ask questions about any public GitHub repository (Devin DeepWiki).',
    vendor: 'Cognition',
    sourceUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'http',
    authMethod: 'none',
    authHint: null,
  },
  {
    source: 'curated',
    key: 'context7',
    name: 'context7',
    label: 'Context7',
    description: 'Up-to-date library documentation and code examples for any framework.',
    vendor: 'Upstash',
    sourceUrl: 'https://github.com/upstash/context7',
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    authMethod: 'none',
    authHint: 'Works without a key (rate-limited); add a Context7 API key for higher limits.',
  },
  {
    source: 'curated',
    key: 'cloudflare-docs',
    name: 'cloudflare-docs',
    label: 'Cloudflare Docs',
    description: 'Search and read Cloudflare developer documentation.',
    vendor: 'Cloudflare',
    sourceUrl: 'https://github.com/cloudflare/mcp-server-cloudflare',
    url: 'https://docs.mcp.cloudflare.com/sse',
    transport: 'sse',
    authMethod: 'none',
    authHint: null,
  },
  {
    source: 'curated',
    key: 'github',
    name: 'github',
    label: 'GitHub',
    description: 'Repositories, issues, pull requests and code search via the official GitHub MCP server.',
    vendor: 'GitHub',
    sourceUrl: 'https://github.com/github/github-mcp-server',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    authMethod: 'bearer',
    authHint: 'Use a GitHub personal access token (fine-grained PAT) as the credential.',
  },
  {
    source: 'curated',
    key: 'stripe',
    name: 'stripe',
    label: 'Stripe',
    description: 'Payments, customers, invoices and products via the official Stripe MCP server.',
    vendor: 'Stripe',
    sourceUrl: 'https://docs.stripe.com/mcp',
    url: 'https://mcp.stripe.com',
    transport: 'http',
    authMethod: 'bearer',
    authHint: 'Use a Stripe API key (restricted keys recommended) as the credential.',
  },
  {
    source: 'curated',
    key: 'zapier',
    name: 'zapier',
    label: 'Zapier',
    description: 'Trigger and run thousands of app actions through Zapier MCP.',
    vendor: 'Zapier',
    sourceUrl: 'https://zapier.com/mcp',
    url: 'https://mcp.zapier.com/api/mcp/mcp',
    transport: 'http',
    authMethod: 'bearer',
    authHint: 'Use your Zapier MCP API key (from the Zapier MCP settings page).',
  },
  {
    source: 'curated',
    key: 'huggingface',
    name: 'huggingface',
    label: 'Hugging Face',
    description: 'Search models, datasets, papers and Spaces on the Hugging Face Hub.',
    vendor: 'Hugging Face',
    sourceUrl: 'https://huggingface.co/settings/mcp',
    url: 'https://huggingface.co/mcp',
    transport: 'http',
    authMethod: 'bearer',
    authHint: 'Use a Hugging Face access token as the credential.',
  },
  {
    source: 'curated',
    key: 'paypal',
    name: 'paypal',
    label: 'PayPal',
    description: 'Invoices, payments and disputes via the official PayPal MCP server.',
    vendor: 'PayPal',
    sourceUrl: 'https://developer.paypal.com/tools/mcp-server/',
    url: 'https://mcp.paypal.com/mcp',
    transport: 'http',
    authMethod: 'bearer',
    authHint: 'Use a PayPal access token as the credential.',
  },
  {
    source: 'curated',
    key: 'square',
    name: 'square',
    label: 'Square',
    description: 'Orders, payments, customers and catalog via the official Square MCP server.',
    vendor: 'Square',
    sourceUrl: 'https://developer.squareup.com/docs/mcp',
    url: 'https://mcp.squareup.com/sse',
    transport: 'sse',
    authMethod: 'bearer',
    authHint: 'Use a Square access token as the credential.',
  },
  {
    source: 'curated',
    key: 'semgrep',
    name: 'semgrep',
    label: 'Semgrep',
    description: 'Scan code for security vulnerabilities with Semgrep.',
    vendor: 'Semgrep',
    sourceUrl: 'https://github.com/semgrep/mcp',
    url: 'https://mcp.semgrep.ai/sse',
    transport: 'sse',
    authMethod: 'none',
    authHint: null,
  },
]

// ─── Official MCP registry client ────────────────────────────────────────────

export const MCP_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io'

/** Subset of the registry's server.schema.json we consume. Unknown fields pass through. */
const RegistryRemoteSchema = z.object({
  type: z.string(),
  url: z.string(),
  headers: z
    .array(
      z.object({
        name: z.string(),
        value: z.string().optional(),
        isRequired: z.boolean().optional(),
        isSecret: z.boolean().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})

const RegistryServerSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  websiteUrl: z.string().optional(),
  repository: z.object({ url: z.string().optional() }).partial().optional(),
  remotes: z.array(RegistryRemoteSchema).optional(),
})

const RegistryResponseSchema = z.object({
  servers: z.array(
    z.object({
      server: RegistryServerSchema,
      _meta: z.record(z.unknown()).optional(),
    }),
  ),
})

type RegistryServer = z.infer<typeof RegistryServerSchema>
type RegistryRemote = z.infer<typeof RegistryRemoteSchema>

const remoteTransport = (remote: RegistryRemote): McpLibraryTransport | null => {
  if (remote.type === 'streamable-http' || remote.type === 'http') return 'http'
  if (remote.type === 'sse') return 'sse'
  return null
}

/**
 * Best-effort auth classification from the registry's declared headers: a
 * required secret `Authorization: Bearer …` header is `bearer`; any other
 * required secret header is `api_key`; otherwise `none`. The registry cannot
 * express OAuth, so servers that actually want OAuth surface as `none` here —
 * a failed unauthenticated probe at install time is the honest signal.
 */
const classifyRemoteAuth = (
  remote: RegistryRemote,
): { authMethod: McpLibraryAuthMethod; authHint: string | null } => {
  const secretHeaders = (remote.headers ?? []).filter((h) => h.isSecret && h.isRequired)
  if (secretHeaders.length === 0) return { authMethod: 'none', authHint: null }
  const auth = secretHeaders.find((h) => h.name.toLowerCase() === 'authorization')
  if (auth && (auth.value ?? '').toLowerCase().startsWith('bearer')) {
    return {
      authMethod: 'bearer',
      authHint: auth.description ?? 'Requires a bearer token in the Authorization header.',
    }
  }
  const first = secretHeaders[0]
  return {
    authMethod: 'api_key',
    authHint: first?.description ?? `Requires the ${first?.name ?? 'API key'} header.`,
  }
}

/** `io.github.someone/thing-mcp` → `thing-mcp`; keep it catalog-name friendly. */
const registryNameToCatalogName = (name: string): string => {
  const tail = name.split('/').pop() ?? name
  const cleaned = tail.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-')
  return cleaned.replace(/^-|-$/g, '') || 'mcp-server'
}

const registryServerToEntry = (server: RegistryServer): McpLibraryEntry | null => {
  const remotes = server.remotes ?? []
  // Prefer streamable HTTP over legacy SSE when a server publishes both.
  const remote =
    remotes.find((r) => remoteTransport(r) === 'http')
    ?? remotes.find((r) => remoteTransport(r) === 'sse')
  if (!remote) return null
  const transport = remoteTransport(remote)
  if (!transport) return null
  const { authMethod, authHint } = classifyRemoteAuth(remote)
  const vendor = server.name.includes('/') ? server.name.split('/')[0] ?? null : null
  return {
    source: 'registry',
    key: server.name,
    name: registryNameToCatalogName(server.name),
    label: server.title ?? server.name,
    description: server.description ?? '',
    vendor,
    sourceUrl: server.websiteUrl ?? server.repository?.url ?? null,
    url: remote.url,
    transport,
    authMethod,
    authHint,
  }
}

export type SearchRegistryOptions = {
  baseUrl?: string
  fetchImpl?: typeof fetch
  limit?: number
  signal?: AbortSignal
}

export class McpLibraryError extends Error {
  override readonly name = 'McpLibraryError'
}

/**
 * Search the official MCP registry. Returns remote-capable servers only
 * (stdio-/package-only servers are dropped — Nessie cannot run them).
 */
export const searchMcpRegistry = async (
  query: string,
  options: SearchRegistryOptions = {},
): Promise<McpLibraryEntry[]> => {
  const baseUrl = options.baseUrl ?? MCP_REGISTRY_BASE_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const url = new URL('/v0/servers', baseUrl)
  if (query.trim().length > 0) url.searchParams.set('search', query.trim())
  url.searchParams.set('version', 'latest')
  url.searchParams.set('limit', String(limit))

  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new McpLibraryError(
      `MCP registry unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new McpLibraryError(`MCP registry returned HTTP ${response.status}`)
  }
  const parsed = RegistryResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new McpLibraryError('MCP registry returned an unexpected payload shape')
  }

  const entries: McpLibraryEntry[] = []
  const seen = new Set<string>()
  for (const item of parsed.data.servers) {
    const entry = registryServerToEntry(item.server)
    if (!entry || seen.has(entry.key)) continue
    seen.add(entry.key)
    entries.push(entry)
  }
  return entries
}

const matchesQuery = (entry: McpLibraryEntry, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return true
  return [entry.name, entry.label, entry.description, entry.vendor ?? '']
    .some((field) => field.toLowerCase().includes(q))
}

export type SearchLibraryOptions = SearchRegistryOptions & {
  /** Skip the live registry call (offline / tests / curated-only view). */
  curatedOnly?: boolean
}

/**
 * Unified library search: curated entries first (they are verified and
 * installable end-to-end), then registry results deduplicated against curated
 * endpoints. Registry unavailability degrades to curated-only rather than
 * failing the whole search.
 */
export const searchMcpLibrary = async (
  query: string,
  options: SearchLibraryOptions = {},
): Promise<{ entries: McpLibraryEntry[]; registryError: string | null }> => {
  const curated = CURATED_MCP_LIBRARY.filter((entry) => matchesQuery(entry, query))
  if (options.curatedOnly) return { entries: curated, registryError: null }

  let registry: McpLibraryEntry[] = []
  let registryError: string | null = null
  try {
    registry = await searchMcpRegistry(query, options)
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error)
  }

  const curatedUrls = new Set(curated.map((entry) => entry.url.replace(/\/$/, '')))
  const merged = [
    ...curated,
    ...registry.filter((entry) => !curatedUrls.has(entry.url.replace(/\/$/, ''))),
  ]
  return { entries: merged, registryError }
}

/**
 * Map a library entry to the catalog-entry creation input shape
 * (`CreateCatalogEntryInput` in `mcp-catalog.ts`). `api_key` entries default
 * to an `Authorization` header because the registry's header metadata is what
 * produced the classification; installers can adjust before use.
 */
export const libraryEntryToCatalogInput = (entry: McpLibraryEntry): {
  name: string
  label: string
  description: string
  protocol: McpLibraryTransport
  authMethod: McpLibraryAuthMethod
  authConfig: Record<string, unknown>
  defaultTransportConfig: Record<string, unknown>
  vendor: string | null
  sourceUrl: string | null
} => ({
  name: entry.name,
  label: entry.label,
  description: entry.description,
  protocol: entry.transport,
  authMethod: entry.authMethod,
  authConfig:
    entry.authMethod === 'api_key'
      ? { method: 'api_key', headerName: 'Authorization', valuePrefix: '' }
      : { method: entry.authMethod },
  defaultTransportConfig: { transport: entry.transport, url: entry.url },
  vendor: entry.vendor,
  sourceUrl: entry.sourceUrl,
})
