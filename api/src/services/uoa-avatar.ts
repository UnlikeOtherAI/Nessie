import type { PrismaClient } from '@prisma/client'
import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import { clientHash, isUoaConfigured, loadUoaSettings, type UoaSettings } from './uoa-auth.js'

/**
 * UOA-hosted avatars, for users and for workspaces ("teams").
 *
 * UOA always has an avatar for a subject it knows: an image uploaded through
 * UOA, a server-side proxy of the social-provider picture (users) or the team's
 * `iconUrl` (workspaces), or a deterministic generated SVG. The `GET` endpoints
 * therefore return `200` + image bytes for anything visible to the authenticated
 * domain, and the standard generic `404` for anything else.
 *
 * Every endpoint used here is the `/domain/*` flavour, authenticated with the
 * domain-hash bearer alone. UOA's own guidance is explicit that this is the path
 * for a product backend: the dual-auth `/org/*` routes need a spendable end-user
 * access token, and Nessie deliberately keeps only a bound refresh credential.
 *
 * The domain hash is a server-side secret, so the browser can never call UOA
 * directly — the API relays the bytes (`routes/users.ts`,
 * `routes/workspace-avatar.ts`).
 *
 * It is also full system trust for the domain: the `/domain/*` mutations apply
 * no role check of their own, and UOA requires the calling product to gate
 * first. That gate lives in `routes/workspace-avatar.ts` and is load-bearing.
 */

const NESSIE_PRODUCT_SLUG = 'nessie'

const AVATAR_TIMEOUT_MS = 10_000

// UOA caps its own provider proxy at 5 MiB and uploads at 1 MiB; anything
// larger is not an avatar and must not be buffered.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

/** UOA's own upload ceiling; Nessie rejects at the same size before buffering. */
export const MAX_AVATAR_UPLOAD_BYTES = 1024 * 1024

// Exactly what UOA documents it can return. Allowlisting here keeps the relay
// from ever becoming a general-purpose proxy for upstream content.
const ALLOWED_AVATAR_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
])

/**
 * What UOA accepts on an upload. It decides the stored type by magic-byte
 * sniffing rather than the declared mimetype, so this is only a fail-fast check
 * that turns an obvious mistake into a clear message instead of a round trip.
 */
export const ALLOWED_AVATAR_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

export type UoaAvatarPrisma = Pick<PrismaClient, 'productAccountLink'>

export type UoaWorkspacePrisma = Pick<PrismaClient, 'team'>

export type UoaAvatarImage = {
  body: Buffer
  // Normalized (parameter-free) content type, always one of ALLOWED_AVATAR_TYPES.
  contentType: string
  // UOA's `X-UOA-Avatar-Source`: uploaded | provider | generated.
  source: string | null
}

export type UoaWorkspace = {
  // The UOA team id — `Team.externalWorkspaceId`.
  externalTeamId: string
  name: string
}

export type UoaAvatarDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
}

/**
 * The upstream could not be consulted, or answered with something unusable.
 * Distinct from "this subject has no UOA avatar", which is a `null` result — the
 * caller maps the two to different statuses.
 */
export class UoaAvatarUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaAvatarUnavailableError'
  }
}

/**
 * UOA refused the submitted image (too large, not a raster image, rate limited).
 * The caller's fault rather than the upstream's, so it maps to a 4xx and carries
 * the status UOA chose.
 */
export class UoaAvatarRejectedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'UoaAvatarRejectedError'
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

/**
 * The UOA workspace behind the actor's session team, or null when there is no
 * team in context or the team was never bound to a UOA workspace (a purely
 * local team). Current-workspace routes scope through the actor's organization.
 * The workspace picker instead supplies `userId` and requires that user's team
 * membership, which safely covers workspaces in every organization the user
 * belongs to.
 */
export const resolveUoaWorkspace = async (
  prisma: UoaWorkspacePrisma,
  input: {
    organizationId?: string
    teamId: string | null | undefined
    userId?: string
  },
): Promise<UoaWorkspace | null> => {
  if (!input.teamId || (!input.organizationId && !input.userId)) {
    return null
  }
  const team = await prisma.team.findFirst({
    where: {
      id: input.teamId,
      ...(input.organizationId
        ? { project: { organizationId: input.organizationId } }
        : {}),
      ...(input.userId ? { members: { some: { userId: input.userId } } } : {}),
    },
    select: { externalWorkspaceId: true, name: true },
  })
  return team?.externalWorkspaceId
    ? { externalTeamId: team.externalWorkspaceId, name: team.name }
    : null
}

/** Configured UOA settings, or null when this deployment has no UOA at all. */
const avatarSettings = (): UoaSettings | null => {
  if (!isUoaConfigured()) {
    return null
  }
  const settings = loadUoaSettings()
  return settings.clientSecret ? settings : null
}

const avatarUrl = (settings: UoaSettings, path: string): URL => {
  const url = new URL(`${settings.baseUrl}${path}`)
  url.searchParams.set('domain', settings.domain)
  return url
}

const authorization = (settings: UoaSettings): string =>
  `Bearer ${clientHash(settings)}`

const normalizeContentType = (value: string | null): string =>
  (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

const unavailable = (message: string): never => {
  throw new UoaAvatarUnavailableError(message)
}

// Egress is IP-pinned, never a bare fetch: `safeFetch` resolves the UOA host
// once and dials only those addresses. Redirects are refused outright — the
// domain-hash bearer must never be replayed to a hop UOA points at.
const avatarFetchOptions = (deps: UoaAvatarDeps) => ({
  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
  maxRedirects: 0,
})

/**
 * Fetch avatar bytes from a `/domain/*` GET endpoint. Returns null when the
 * subject is unknown to the domain, and throws when the upstream is unreachable
 * or answers with something that is not a usable image.
 */
const fetchAvatarImage = async (
  settings: UoaSettings,
  path: string,
  deps: UoaAvatarDeps,
): Promise<UoaAvatarImage | null> => {
  let response: Response
  try {
    response = await safeFetch(avatarUrl(settings, path), {
      headers: {
        Accept: 'image/*',
        Authorization: authorization(settings),
      },
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    }, avatarFetchOptions(deps))
  } catch {
    return unavailable('[uoa] the avatar endpoint is temporarily unavailable')
  }

  // Generic 404 — unknown to this domain, or not visible to it.
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    return unavailable(`[uoa] the avatar endpoint returned ${response.status}`)
  }

  const contentType = normalizeContentType(response.headers.get('content-type'))
  if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
    return unavailable('[uoa] the avatar endpoint returned an unsupported content type')
  }

  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES) {
    return unavailable('[uoa] the avatar endpoint returned an unusable image body')
  }

  return {
    body,
    contentType,
    source: response.headers.get('x-uoa-avatar-source'),
  }
}

/** Send a mutation to a `/domain/*` avatar endpoint and check its verdict. */
const mutateAvatar = async (
  settings: UoaSettings,
  path: string,
  init: { method: 'PUT' | 'DELETE'; body?: FormData },
  deps: UoaAvatarDeps,
): Promise<void> => {
  let response: Response
  try {
    response = await safeFetch(avatarUrl(settings, path), {
      method: init.method,
      headers: {
        Accept: 'application/json',
        Authorization: authorization(settings),
      },
      body: init.body,
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    }, avatarFetchOptions(deps))
  } catch {
    return unavailable('[uoa] the avatar endpoint is temporarily unavailable')
  }

  if (response.ok) {
    return
  }
  // UOA answers a bad image, an oversize body or an exhausted rate limit with a
  // 4xx; that is the caller's problem, not an outage.
  if (response.status === 429) {
    throw new UoaAvatarRejectedError(
      'Too many workspace avatar changes. Try again later.',
      429,
    )
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 404) {
    throw new UoaAvatarRejectedError(
      'UnlikeOtherAI rejected the image. Use a PNG, JPEG or WebP under 1 MB.',
      400,
    )
  }
  return unavailable(`[uoa] the avatar endpoint returned ${response.status}`)
}

/**
 * Fetch a UOA user's avatar bytes. Null when UOA is not configured for this
 * deployment or does not know the subject.
 */
export const fetchUoaUserAvatar = async (
  uoaSub: string,
  deps: UoaAvatarDeps = {},
): Promise<UoaAvatarImage | null> => {
  const settings = avatarSettings()
  if (!settings) {
    return null
  }
  return fetchAvatarImage(
    settings,
    `/domain/users/${encodeURIComponent(uoaSub)}/avatar`,
    deps,
  )
}

/**
 * Fetch a UOA workspace's ("team") avatar bytes. Null when UOA is not configured
 * or the team belongs to another domain.
 */
export const fetchUoaWorkspaceAvatar = async (
  externalTeamId: string,
  deps: UoaAvatarDeps = {},
): Promise<UoaAvatarImage | null> => {
  const settings = avatarSettings()
  if (!settings) {
    return null
  }
  return fetchAvatarImage(
    settings,
    `/domain/teams/${encodeURIComponent(externalTeamId)}/avatar`,
    deps,
  )
}

/**
 * Replace a workspace's uploaded avatar. UOA decides the stored type by
 * magic-byte sniffing, so the declared type here is a hint, not a promise.
 * Returns false when UOA is not configured (nothing to write to).
 */
export const putUoaWorkspaceAvatar = async (
  externalTeamId: string,
  image: { body: Buffer; contentType: string; filename: string },
  deps: UoaAvatarDeps = {},
): Promise<boolean> => {
  const settings = avatarSettings()
  if (!settings) {
    return false
  }
  const form = new FormData()
  form.append(
    'file',
    new Blob([image.body], { type: image.contentType }),
    image.filename,
  )
  await mutateAvatar(
    settings,
    `/domain/teams/${encodeURIComponent(externalTeamId)}/avatar`,
    { method: 'PUT', body: form },
    deps,
  )
  return true
}

/**
 * Clear a workspace's uploaded avatar; UOA falls resolution back to the team's
 * `iconUrl` or the generated image. Idempotent. Returns false when UOA is not
 * configured.
 */
export const deleteUoaWorkspaceAvatar = async (
  externalTeamId: string,
  deps: UoaAvatarDeps = {},
): Promise<boolean> => {
  const settings = avatarSettings()
  if (!settings) {
    return false
  }
  await mutateAvatar(
    settings,
    `/domain/teams/${encodeURIComponent(externalTeamId)}/avatar`,
    { method: 'DELETE' },
    deps,
  )
  return true
}
