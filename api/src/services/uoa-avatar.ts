import type { PrismaClient } from '@prisma/client'

import { clientHash, isUoaConfigured, loadUoaSettings } from './uoa-auth.js'

/**
 * UOA-hosted user avatars.
 *
 * UOA always has an avatar for a user it knows: an image uploaded through UOA,
 * a server-side proxy of the social-provider picture, or a deterministic
 * generated SVG. `GET /domain/users/:uoaSub/avatar?domain=…` therefore returns
 * `200` + image bytes for any user visible to the authenticated domain, and the
 * standard generic `404` for anyone else.
 *
 * The endpoint is authenticated with the domain-hash bearer — a server-side
 * secret — so the browser can never call it directly. `GET /api/users/:id/avatar`
 * relays the bytes instead (see `routes/users.ts`).
 */

const NESSIE_PRODUCT_SLUG = 'nessie'

const AVATAR_TIMEOUT_MS = 10_000

// UOA caps its own provider proxy at 5 MiB and uploads at 1 MiB; anything
// larger is not an avatar and must not be buffered.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

// Exactly what UOA documents it can return. Allowlisting here keeps the relay
// from ever becoming a general-purpose proxy for upstream content.
const ALLOWED_AVATAR_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
])

export type UoaAvatarPrisma = Pick<PrismaClient, 'productAccountLink'>

export type UoaAvatarImage = {
  body: Buffer
  // Normalized (parameter-free) content type, always one of ALLOWED_AVATAR_TYPES.
  contentType: string
  // UOA's `X-UOA-Avatar-Source`: uploaded | provider | generated.
  source: string | null
}

/**
 * The upstream could not be consulted, or answered with something unusable.
 * Distinct from "this user has no UOA avatar", which is a `null` result — the
 * caller maps the two to different statuses.
 */
export class UoaAvatarUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaAvatarUnavailableError'
  }
}

/**
 * The UOA subject for a Nessie user, or null when the user has never linked.
 * Scoped to the caller's organization: the `(organizationId, userId,
 * productSlug)` key is what stops one tenant resolving another tenant's users.
 */
export const resolveUoaAvatarSubject = async (
  prisma: UoaAvatarPrisma,
  input: { organizationId: string; userId: string },
): Promise<string | null> => {
  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: input.organizationId,
        productSlug: NESSIE_PRODUCT_SLUG,
        userId: input.userId,
      },
    },
    select: { status: true, uoaSub: true },
  })
  return link?.status === 'linked' && link.uoaSub ? link.uoaSub : null
}

const normalizeContentType = (value: string | null): string =>
  (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/**
 * Fetch a UOA user's avatar bytes with the domain-hash bearer. Returns null when
 * UOA is not configured for this deployment or does not know the subject, and
 * throws {@link UoaAvatarUnavailableError} when the upstream is unreachable or
 * answers with something that is not a usable image.
 */
export const fetchUoaUserAvatar = async (
  uoaSub: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<UoaAvatarImage | null> => {
  if (!isUoaConfigured()) {
    return null
  }
  const settings = loadUoaSettings()
  if (!settings.clientSecret) {
    return null
  }

  const url = new URL(
    `${settings.baseUrl}/domain/users/${encodeURIComponent(uoaSub)}/avatar`,
  )
  url.searchParams.set('domain', settings.domain)

  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(url, {
      headers: {
        Accept: 'image/*',
        Authorization: `Bearer ${clientHash(settings)}`,
      },
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    })
  } catch {
    throw new UoaAvatarUnavailableError(
      '[uoa] the avatar endpoint is temporarily unavailable',
    )
  }

  // Generic 404 — unknown to this domain, or not visible to it.
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new UoaAvatarUnavailableError(
      `[uoa] the avatar endpoint returned ${response.status}`,
    )
  }

  const contentType = normalizeContentType(response.headers.get('content-type'))
  if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
    throw new UoaAvatarUnavailableError(
      '[uoa] the avatar endpoint returned an unsupported content type',
    )
  }

  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES) {
    throw new UoaAvatarUnavailableError(
      '[uoa] the avatar endpoint returned an unusable image body',
    )
  }

  return {
    body,
    contentType,
    source: response.headers.get('x-uoa-avatar-source'),
  }
}
