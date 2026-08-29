import { isAdminActor } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { resolveAvailableAppSlug } from './apps/app-slug.js'
import {
  ensureAuthConfigMatchesMethod,
  isAdminUser,
  type CreateCatalogEntryInput,
  type McpCatalogEntryRow,
} from './mcp-catalog.js'
import { findApplicableLock } from './mcp-catalog-endpoint-lock.js'
import { MCP_CATALOG_ERROR_CODES, McpCatalogError } from './mcp-catalog-errors.js'
import {
  assertCatalogSecurity,
  duplicateNameError,
  isSlugUniqueViolation,
  isUniqueViolation,
  toJsonRecord,
} from './mcp-catalog-guards.js'

/**
 * Authoring a catalog entry.
 *
 * Its own module because creation carries the whole admission story — the
 * endpoint lock a member must not route around, and the slug allocation the
 * App Store's `/apps/:slug` depends on — while the rest of `mcp-catalog.ts` is
 * reads and lifecycle transitions.
 */

export const createCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateCatalogEntryInput,
): Promise<McpCatalogEntryRow> => {
  const authConfig = ensureAuthConfigMatchesMethod(input.authMethod, input.authConfig)
  await assertCatalogSecurity({
    authConfig,
    defaultTransportConfig: input.defaultTransportConfig,
    protocol: input.protocol,
  })

  // A member must not bypass an admin lock by re-registering the same
  // endpoint under a fresh name. Owners/admins are exempt.
  const transportUrl =
    input.defaultTransportConfig && typeof input.defaultTransportConfig.url === 'string'
      ? input.defaultTransportConfig.url
      : null
  if (transportUrl) {
    const lock = await findApplicableLock(
      prisma,
      actorContext.tenant.organizationId,
      null,
      transportUrl,
    )
    if (lock) {
      const isAdmin =
        isAdminActor(actorContext)
        || (await isAdminUser(
          prisma,
          actorContext.tenant.organizationId,
          actorContext.actor.actorId,
        ))
      if (!isAdmin) {
        throw new McpCatalogError(
          MCP_CATALOG_ERROR_CODES.LOCKED,
          `This endpoint belongs to "${lock.label}", which is locked by your organisation's admins`,
        )
      }
    }
  }

  const insert = (slug: string | null): Promise<McpCatalogEntryRow> =>
    prisma.mcpCatalogEntry.create({
      data: {
        organizationId: actorContext.tenant.organizationId,
        name: input.name,
        label: input.label,
        description: input.description ?? '',
        protocol: input.protocol,
        authMethod: input.authMethod,
        authConfig: authConfig as object,
        defaultTransportConfig: toJsonRecord(input.defaultTransportConfig) as object,
        iconUrl: input.iconUrl ?? null,
        vendor: input.vendor ?? null,
        sourceUrl: input.sourceUrl ?? null,
        signature: input.signature ?? null,
        status: 'draft',
        visibility: 'private',
        // A person wrote this, so it is an app rather than a registry record
        // nobody has looked at. The column defaults to `discovered`, which the
        // store read filters out — leaving the Apps page's own "Add custom MCP
        // server" producing a row that page can never show. `curated` is what
        // the store migration gave every pre-existing human-authored entry,
        // and it stays private to its owner until the entry is published.
        moderationState: 'curated',
        slug,
        ownerUserId: actorContext.actor.actorId,
        createdBy: actorContext.actor.actorId,
      },
    })

  // Resolved immediately before each insert with the unique index left as the
  // arbiter, so a writer that took the candidate in between is a retry, not a
  // failure blamed on the author as a duplicate *name*. The last attempt gives
  // up the slug rather than the row: `slug` is nullable by design (an
  // unsluggable name resolves to null too) and `/apps/:id` still resolves such
  // an app, so a pathological race costs the readable URL, never the entry.
  const SLUG_ATTEMPTS = 3
  let slugConflict: unknown
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const slug =
      attempt < SLUG_ATTEMPTS
        ? await resolveAvailableAppSlug(prisma, input.name)
        : null
    try {
      return await insert(slug)
    } catch (error) {
      if (!isSlugUniqueViolation(error)) {
        if (isUniqueViolation(error)) throw duplicateNameError(input.name)
        throw error
      }
      slugConflict = error
    }
  }
  throw slugConflict
}
