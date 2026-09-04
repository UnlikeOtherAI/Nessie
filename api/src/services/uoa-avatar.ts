import type { PrismaClient } from '@prisma/client'
import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'

import { clientHash, isUoaConfigured, loadUoaSettings, type UoaSettings } from './uoa-auth.js'

/**
 * UOA-hosted avatars, for users and for teams ("teams").
 *
 * UOA always has an avatar for a subject it knows: an image uploaded through
 * UOA, a server-side proxy of the social-provider picture (users) or the team's
 * `iconUrl` (teams), or a deterministic generated SVG. The `GET` endpoints
 * therefore return `200` + image bytes for anything visible to the authenticated
 * domain, and the standard generic `404` for anything else.
 *
 * Two upstream families are used, and which one a team call takes is not
 * cosmetic:
 *
 * - `/domain/*`, the domain-hash bearer alone. It is the only path for a call
 *   with no acting person (a user avatar read, a team the caller is not
 *   entitled to access without an assertable organisation session), and it is
 *   scoped to organisations that were
 *   **created on** this product's domain. An organisation founded on another
 *   UOA-integrated domain answers the generic `404` here for every method —
 *   which is why the team avatar looked empty in settings, and why an
 *   upload could never replace the team's SSO icon, for exactly the tenants
 *   who joined Nessie from an organisation they already had.
 * - `/org/*`, the same domain hash plus a short-lived product-signed assertion
 *   of the signed-in person (`withUoaRosterSubjectAssertion`). UOA re-resolves
 *   that person's live membership and their `teams.manage` capability, and the
 *   organisation's origin domain is deliberately not a predicate — "one
 *   organisation is usable from every UOA-integrated product". This is the path
 *   for teams in the asserted organisation: UOA re-resolves whether that
 *   person may access the exact team named in the route.
 *
 * The domain hash is a server-side secret, so the browser can never call UOA
 * directly — the API relays the bytes (`routes/users.ts`,
 * `routes/team-avatar.ts`).
 *
 * It is also full system trust for the domain: the `/domain/*` mutations apply
 * no role check of their own, and UOA requires the calling product to gate
 * first. That gate lives in `routes/team-avatar.ts` and is load-bearing.
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

export type UoaUserPrisma = Pick<PrismaClient, 'user'>

export type UoaTeamPrisma = Pick<PrismaClient, 'team'>

export type UoaAvatarImage = {
  body: Buffer
  // Normalized (parameter-free) content type, always one of ALLOWED_AVATAR_TYPES.
  contentType: string
  // UOA's `X-UOA-Avatar-Source`: uploaded | provider | generated.
  source: string | null
}

export type UoaTeam = {
  // The UOA organisation id — `Team.externalOrgId`. Null for a team bound
  // to a UOA team without one; the `/org/*` routes are unreachable without it,
  // so such a team can only use the `/domain/*` relay.
  externalOrgId: string | null
  // The UOA team id — `Team.externalTeamId`.
  externalTeamId: string
  name: string
}

export type UoaAvatarDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
  /**
   * A short-lived product-signed assertion of the signed-in UOA user. Its
   * presence selects the `/org/*` family: the header goes up, and so does the
   * `config_url` those routes verify the product's signature against. The
   * `/domain/*` calls must never carry it.
   */
  subjectAssertion?: string
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
 * The acting user's OWN stable UOA subject, or null when this account is not a
 * UOA principal. Read from `User.uoaSub` — the subject a UOA login is keyed by
 * — and never from anything in the request: the `/domain/*` mutations apply no
 * check of their own, so a caller-supplied subject would let anyone rewrite any
 * person's picture in the whole UOA domain.
 */
export const resolveOwnUoaSubject = async (
  prisma: UoaUserPrisma,
  userId: string,
): Promise<string | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { uoaSub: true },
  })
  return user?.uoaSub ?? null
}

/**
 * The UOA team behind the actor's session team, or null when there is no
 * team in context or the team was never bound to a UOA team (a purely
 * local team). Current-team routes scope through the actor's organization.
 * The team picker instead supplies `userId` and requires that user's team
 * membership, which safely covers teams in every organization the user
 * belongs to.
 */
export const resolveUoaTeam = async (
  prisma: UoaTeamPrisma,
  input: {
    organizationId?: string
    teamId: string | null | undefined
    userId?: string
  },
): Promise<UoaTeam | null> => {
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
    select: { externalOrgId: true, externalTeamId: true, name: true },
  })
  return team?.externalTeamId
    ? {
      externalOrgId: team.externalOrgId ?? null,
      externalTeamId: team.externalTeamId,
      name: team.name,
    }
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

const avatarUrl = (
  settings: UoaSettings,
  path: string,
  deps: UoaAvatarDeps = {},
): URL => {
  const url = new URL(`${settings.baseUrl}${path}`)
  url.searchParams.set('domain', settings.domain)
  // `/org/*` runs the config verifier, which needs the product's signed config.
  if (deps.subjectAssertion) url.searchParams.set('config_url', settings.configUrl)
  return url
}

const authorization = (settings: UoaSettings): string =>
  `Bearer ${clientHash(settings)}`

const upstreamHeaders = (
  settings: UoaSettings,
  accept: string,
  deps: UoaAvatarDeps,
): Record<string, string> => ({
  Accept: accept,
  Authorization: authorization(settings),
  ...(deps.subjectAssertion
    ? { 'X-UOA-Subject-Assertion': deps.subjectAssertion }
    : {}),
})

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
    response = await safeFetch(avatarUrl(settings, path, deps), {
      headers: upstreamHeaders(settings, 'image/*', deps),
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
    response = await safeFetch(avatarUrl(settings, path, deps), {
      method: init.method,
      headers: upstreamHeaders(settings, 'application/json', deps),
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
      'Too many team avatar changes. Try again later.',
      429,
    )
  }
  // An authorization refusal is only reachable on the `/org/*` family, which
  // re-resolves the acting person's own `teams.manage` capability — the
  // `/domain/*` mutations apply no role check at all, so they cannot 403. It
  // must not fall into the branch below: telling a Nessie admin who lacks that
  // UOA capability to "use a PNG under 1 MB" sends them to fix an image that
  // was never the problem.
  if (response.status === 401 || response.status === 403) {
    throw new UoaAvatarRejectedError(
      'UnlikeOtherAI would not accept this change. You may not have permission to change '
      + 'this picture there.',
      403,
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
 * Where a team's avatar lives upstream, for this caller.
 *
 * With a subject assertion the person is the authority and the `/org/*` route
 * is reachable for an organisation founded anywhere; without one there is no
 * acting person to assert, and only the origin-domain-scoped `/domain/*` route
 * remains. A team with no `externalOrgId` cannot address `/org/*` at all,
 * so it stays on `/domain/*` even when an assertion was supplied.
 */
const teamAvatarPath = (
  team: UoaTeam,
  deps: UoaAvatarDeps = {},
): string =>
  deps.subjectAssertion && team.externalOrgId
    ? `/org/organisations/${encodeURIComponent(team.externalOrgId)}`
      + `/teams/${encodeURIComponent(team.externalTeamId)}/avatar`
    : `/domain/teams/${encodeURIComponent(team.externalTeamId)}/avatar`

/**
 * Fetch a UOA team's ("team") avatar bytes. Null when UOA is not
 * configured, or when the chosen route cannot see the team — for `/domain/*`,
 * an organisation founded on another domain.
 */
export const fetchUoaTeamAvatar = async (
  team: UoaTeam,
  deps: UoaAvatarDeps = {},
): Promise<UoaAvatarImage | null> => {
  const settings = avatarSettings()
  if (!settings) {
    return null
  }
  return fetchAvatarImage(settings, teamAvatarPath(team, deps), deps)
}

export type UoaAvatarUpload = { body: Buffer; contentType: string; filename: string }

/** UOA wants exactly one multipart part, named `file`. */
const avatarUploadForm = (image: UoaAvatarUpload): FormData => {
  const form = new FormData()
  form.append(
    'file',
    new Blob([image.body], { type: image.contentType }),
    image.filename,
  )
  return form
}

/**
 * Replace an uploaded avatar. UOA decides the stored type by magic-byte
 * sniffing, so the declared type here is a hint, not a promise. Returns false
 * when UOA is not configured (nothing to write to).
 */
const putAvatar = async (
  path: string,
  image: UoaAvatarUpload,
  deps: UoaAvatarDeps,
): Promise<boolean> => {
  const settings = avatarSettings()
  if (!settings) {
    return false
  }
  await mutateAvatar(settings, path, { method: 'PUT', body: avatarUploadForm(image) }, deps)
  return true
}

/**
 * Clear an uploaded avatar; UOA falls resolution back to the provider picture /
 * team icon or its generated image. Idempotent. Returns false when UOA is not
 * configured.
 */
const deleteAvatar = async (path: string, deps: UoaAvatarDeps): Promise<boolean> => {
  const settings = avatarSettings()
  if (!settings) {
    return false
  }
  await mutateAvatar(settings, path, { method: 'DELETE' }, deps)
  return true
}

const userAvatarPath = (uoaSub: string): string =>
  `/domain/users/${encodeURIComponent(uoaSub)}/avatar`

/**
 * Replace the team's UOA-hosted picture. This is the override: UOA
 * resolves a team avatar as uploaded image → the team's `iconUrl` → generated
 * SVG, so an upload here takes precedence over the icon the SSO holds,
 * everywhere the team is drawn.
 */
export const putUoaTeamAvatar = (
  team: UoaTeam,
  image: UoaAvatarUpload,
  deps: UoaAvatarDeps = {},
): Promise<boolean> => putAvatar(teamAvatarPath(team, deps), image, deps)

/** Clear the override; UOA falls back to the team's SSO icon, then generated. */
export const deleteUoaTeamAvatar = (
  team: UoaTeam,
  deps: UoaAvatarDeps = {},
): Promise<boolean> => deleteAvatar(teamAvatarPath(team, deps), deps)

/**
 * Replace the UOA-hosted picture for one person. The subject must be the acting
 * user's own (`resolveOwnUoaSubject`): this is the full-trust domain-hash path,
 * so Nessie's own gate is the only thing scoping the write to that person.
 */
export const putUoaUserAvatar = (
  uoaSub: string,
  image: UoaAvatarUpload,
  deps: UoaAvatarDeps = {},
): Promise<boolean> => putAvatar(userAvatarPath(uoaSub), image, deps)

/** Clear one person's uploaded UOA picture; UOA falls back to its own chain. */
export const deleteUoaUserAvatar = (
  uoaSub: string,
  deps: UoaAvatarDeps = {},
): Promise<boolean> => deleteAvatar(userAvatarPath(uoaSub), deps)
