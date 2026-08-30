import type { McpServerScopeType } from '@nessie/schemas'

import { discoverMcpEndpoint } from '../discovery.js'
import { libraryEntryToCatalogInput, type McpLibraryEntry } from '../library.js'
import { publishCatalogEntry, type McpCatalogEntryRow } from '../mcp-catalog.js'
import { createCatalogEntry } from '../mcp-catalog-create.js'
import { normalizeEndpoint } from '../registry/registry-mapper.js'

import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  resolveConnection,
  runConnectHandshake,
  type AppConnectContext,
  type AppConnectOutcome,
} from './app-connect.js'
import { toAppSlug } from './app-slug.js'

/**
 * "Add a custom app" — the `/apps` page's own doorway for a server that is not
 * in the catalogue yet.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-detail-and-connect.md`
 * §5. Its own module because authoring a catalogue row from a pasted address
 * is a different responsibility from connecting an app that already has one —
 * and because both of those, together, exceed the file cap.
 *
 * Every hard part is already built: `discoverMcpEndpoint` probes the candidate
 * paths over both remote transports behind the SSRF guard and reports what the
 * server wants, `createCatalogEntry` applies the admin endpoint lock and
 * refuses stdio, and the connect orchestration takes it from there.
 */

export type AddCustomAppInput = {
  url: string
  name?: string
  scopeType: McpServerScopeType
  scopeId: string
}

export type AddCustomAppResult = {
  app: McpCatalogEntryRow
  outcome: AppConnectOutcome
}

/**
 * A label a person will recognise, from what they gave us: their own words
 * first, the server's host otherwise. The host is the only thing an
 * unauthenticated endpoint reliably tells us about itself.
 */
const customAppLabel = (endpoint: string, name?: string): string => {
  const given = name?.trim()
  if (given) return given
  try {
    return new URL(endpoint).hostname
  } catch {
    return endpoint
  }
}

/**
 * One server is one app, even here: pasting the same address again under the
 * same name resolves to the app the person already added, not a rival row
 * beside it. A same-name-different-server clash is a genuine collision, and
 * `createCatalogEntry`'s duplicate-name refusal is the right answer to it.
 */
const resolveCustomCatalogEntry = async (
  ctx: AppConnectContext,
  input: {
    endpoint: string
    label: string
    machineName: string
    transport: 'http' | 'sse'
    authMethod: McpLibraryEntry['authMethod']
  },
): Promise<McpCatalogEntryRow> => {
  const existing = await ctx.prisma.mcpCatalogEntry.findFirst({
    where: {
      name: input.machineName,
      ownerUserId: ctx.actorContext.actor.actorId,
      organizationId: ctx.actorContext.tenant.organizationId,
    },
  })
  if (existing) {
    const config = existing.defaultTransportConfig as { url?: unknown } | null
    const url = typeof config?.url === 'string' ? config.url : null
    if (url && (normalizeEndpoint(url) ?? url) === input.endpoint) return existing
  }

  // `libraryEntryToCatalogInput` owns how an auth method becomes an auth
  // config — `api_key` gets its header, `oauth2` stays client-less so
  // endpoints and a client are discovered at connect time. A custom server is
  // that same mapping applied to a discovery proposal instead of a library row.
  const created = await createCatalogEntry(ctx.prisma, ctx.actorContext, {
    ...libraryEntryToCatalogInput({
      source: 'registry',
      key: input.endpoint,
      name: input.machineName,
      label: input.label,
      description: '',
      vendor: null,
      sourceUrl: null,
      url: input.endpoint,
      transport: input.transport,
      authMethod: input.authMethod,
      authHint: null,
    }),
  })
  // Published private, matching `POST /api/mcp/library/import`, so an app added
  // here and one imported from the Library tab are the same kind of row.
  return (await publishCatalogEntry(ctx.prisma, ctx.actorContext, created.id)) ?? created
}

export const addCustomApp = async (
  ctx: AppConnectContext,
  input: AddCustomAppInput,
): Promise<AddCustomAppResult> => {
  const discovered = await discoverMcpEndpoint(input.url)
  const proposal = discovered.proposal
  if (!discovered.ok || !proposal) {
    throw new AppConnectError(
      APP_CONNECT_ERROR_CODES.SERVER_INVALID,
      "That address doesn't look like an app server.",
    )
  }

  // Canonical on the way in, exactly as registry ingestion persists it, so an
  // admin lock recorded on `https://api.example.com/mcp` still catches
  // `https://API.Example.com:443/mcp` pasted by hand.
  const endpoint = normalizeEndpoint(proposal.url) ?? proposal.url
  const label = customAppLabel(endpoint, input.name)
  const machineName = toAppSlug(label) ?? toAppSlug(endpoint)
  if (!machineName) {
    throw new AppConnectError(
      APP_CONNECT_ERROR_CODES.SERVER_INVALID,
      'Give this app a name we can address it by.',
    )
  }

  const entry = await resolveCustomCatalogEntry(ctx, {
    endpoint,
    label,
    machineName,
    transport: proposal.transport,
    authMethod: proposal.authMethod,
  })
  const instance = await resolveConnection(ctx, entry.id, input.scopeType, input.scopeId)
  return { app: entry, outcome: await runConnectHandshake(ctx, entry, instance) }
}
