import { createHash, timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  isAdminActor,
  OrganizationThemeSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  checkUoaSlugAvailability,
  createUoaOrganisation,
  resolveUoaOrgAddress,
  resolveUoaOrgHost,
  resolveUoaTeamAddress,
  resolveUoaTeamHost,
  createUoaTeamTeam,
  provisionOnce,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * Founding a UOA organisation, or a further team inside one, from inside
 * Nessie — so that neither costs a second interactive login.
 *
 * These routes create **nothing locally**. UOA owns the organisation/team
 * hierarchy, and the local `Organization`/`Team`/`Project`/`#general` mirror is
 * born in `materializeUoaTeam`, from a team UOA itself proved in an
 * authenticated response. That is why both handlers answer only a pair of UOA
 * ids: the client then calls the ordinary `POST /api/auth/uoa/team`, and
 * the existing silent switch grant does the materializing. Writing a local row
 * here would be inventing an organisation ahead of UOA's proof.
 *
 * The two routes deliberately use different UOA credential modes; the reasons
 * are on the service functions in `@nessie/team-admin`.
 */

// Shared by both routes: an organisation's address and a team's address are
// different things, but the field they arrive in has the same shape and the
// same rules, and UOA validates each against the right scope.
const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // The address the person chose. Omitted lets UOA derive one from the name;
  // supplied, UOA validates it and refuses with a reason rather than storing
  // something else. Nessie never derives or stores a slug of its own — the
  // labels belong to UOA.
  slug: z.string().trim().min(2).max(63).optional(),
  // Distinguishes a retry of one intent from a second intent. See the ledger
  // note below: without it, a retry after an ambiguous network failure mints a
  // second organisation nobody asked for.
  idempotencyKey: z.string().trim().min(8).max(200),
})

const ResolveHostQuerySchema = z.object({
  host: z.string().trim().min(1).max(253),
})

/**
 * Split `<team>.<org>.<base>` into its two labels.
 *
 * Returns null unless the host sits exactly two labels under the configured
 * base domain, so a hostname that merely *ends* with the base — a different
 * registrable domain that happens to share the suffix — is never treated as
 * one of ours.
 */
/** A legal DNS label — the same shape the slug rules enforce. */
const LEGAL_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

type ParsedHost =
  | { kind: 'organisation'; orgSlug: string }
  | { kind: 'team'; orgSlug: string; teamSlug: string }

/**
 * Split a tenant hostname into the labels it carries.
 *
 * One label under the base domain is an organisation — its portal. Two is a
 * team inside that organisation. Anything else is not ours: `app.nessie.works`
 * has one label but is the product's own host, so it never reaches here (it is
 * not a tenant slug and resolution simply finds no organisation by that name).
 *
 * Returns null unless the host sits exactly under the configured base domain,
 * so a different registrable domain that merely ends with the same string —
 * `evil-nessie.works` — is never treated as one of ours. That is a label
 * comparison, deliberately, not `endsWith`.
 */
const parseTenantHost = (
  host: string,
  baseDomain: string | undefined,
): ParsedHost | null => {
  if (!baseDomain) return null

  const normalized = host.trim().toLowerCase().replace(/\.+$/, '').split(':')[0] ?? ''
  const base = baseDomain.trim().toLowerCase()
  if (!normalized.endsWith(`.${base}`)) return null

  const labels = normalized.slice(0, -(base.length + 1)).split('.')

  if (labels.length === 1) {
    const [orgSlug] = labels
    if (!orgSlug || !LEGAL_LABEL.test(orgSlug)) return null
    return { kind: 'organisation', orgSlug }
  }

  if (labels.length === 2) {
    const [teamSlug, orgSlug] = labels
    if (!teamSlug || !orgSlug) return null
    if (!LEGAL_LABEL.test(teamSlug) || !LEGAL_LABEL.test(orgSlug)) return null
    return { kind: 'team', orgSlug, teamSlug }
  }

  return null
}

/**
 * The edge appends `domain` to whatever URL it is configured with, so the key
 * rides along in that configured URL. Both are bounded here: a hostname is at
 * most 253 bytes, and an unbounded key would let a caller make this route do
 * arbitrary-length comparison work.
 */
const TlsCheckQuerySchema = z.object({
  domain: z.string().trim().min(1).max(253),
  key: z.string().min(1).max(512),
})

/**
 * Compare without leaking the answer through how long it took.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length,
 * so both sides are hashed to a fixed width first.
 */
const timingSafeEquals = (a: string, b: string): boolean => {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

const AddressQuerySchema = z.object({
  teamId: z.string().trim().min(1).max(64).optional(),
  orgId: z.string().trim().min(1).max(64).optional(),
})

const SlugAvailableQuerySchema = z.object({
  slug: z.string().trim().min(1).max(63),
  scope: z.enum(['organisation', 'team']),
  // Required for a team address: availability is per organisation, never global.
  orgId: z.string().trim().min(1).optional(),
})

const ORG_CREATED_ACTION = 'organization.external_created'
const TEAM_CREATED_ACTION = 'team.external_created'

/**
 * What `TEAM_CREATED_ACTION` was called before the workspace->team rename.
 *
 * Rows written under it are left as they were: an audit trail records what was
 * done at the time, and rewriting it to tidy vocabulary is not a trade worth
 * making. The consequence is that this one action spans two names, so anything
 * reporting on team provisioning has to ask for both or it silently starts its
 * history at the rename.
 */
export const LEGACY_TEAM_CREATED_ACTIONS = [
  'workspace.external_created',
  TEAM_CREATED_ACTION,
] as const

const NEEDS_UOA_SESSION =
  'Sign in with UnlikeOtherAI to create an organisation.'

const auditRequestFields = (request: FastifyRequest) => ({
  requestId: request.id,
  ipAddress: request.ip ?? null,
  userAgent: typeof request.headers['user-agent'] === 'string'
    ? request.headers['user-agent']
    : null,
})

/** Map a provisioning failure onto the API's error envelope. */
const sendProvisioningError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean => {
  if (error instanceof UoaRosterRejectedError) {
    // 400 with no owner is the one refusal a person can act on: it means UOA
    // has no record of them on this domain, which signing in again repairs.
    const missingOwner = error.upstreamCode === 'OWNER_REQUIRED'
      || error.upstreamCode === 'OWNER_NOT_ALLOWED'
    sendApiError(
      reply,
      error.statusCode === 429 ? 429 : missingOwner ? 409 : 400,
      error.statusCode === 429 ? 'UOA_RATE_LIMITED' : 'UOA_PROVISIONING_REJECTED',
      error.statusCode === 429
        ? 'UnlikeOtherAI is rate-limiting new organisations for this deployment. Try again shortly.'
        : missingOwner
          ? 'UnlikeOtherAI could not confirm your account on this deployment. Sign out and in again, then retry.'
          : 'UnlikeOtherAI refused the request.',
    )
    return true
  }
  if (error instanceof UoaRosterIdentityError) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', NEEDS_UOA_SESSION)
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa provisioning failed')
    sendApiError(
      reply,
      502,
      'UOA_DIRECTORY_UNAVAILABLE',
      'UnlikeOtherAI is temporarily unavailable. Nothing was changed; try again.',
    )
    return true
  }
  return false
}

const requireUoaSubject = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): string | null => {
  const subject = actorContext.actionContext.uoaIdentity?.subject
  if (!subject) {
    sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', NEEDS_UOA_SESSION)
    return null
  }
  return subject
}

export const registerTeamProvisioningRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    teamHostBaseDomain,
    tlsCheckKey,
  } = deps

  /**
   * Found a new UOA organisation, owned by the caller.
   *
   * **Any active member**, which is the flow this replaces, not a widening of
   * it. The old "Add team" redirect sent people into UOA's chooser in
   * user mode, where `org_features.allow_user_create_org` (true for this
   * deployment) lets any authenticated user of the domain found one — so
   * owner-gating here would quietly take a capability away from members while
   * claiming only to remove a login.
   *
   * It is also the right shape on its own terms: founding an organisation is
   * not an act upon the current tenant. It reads nothing from it, changes
   * nothing in it, and produces a separate tenancy in which the caller is the
   * owner. The route that DOES write into the current tenant — adding a
   * team, below — carries the owner/admin gate.
   *
   * What backend mode costs is the upstream role check, and the answer to that
   * is not a stricter role but the two things that ARE checked here: a live,
   * non-deactivated membership (re-resolved per request by
   * `requireActorContext`, so a revoked account cannot mint tenancies) and a
   * linked UOA subject to own the result.
   */
  app.post('/api/teams/organizations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply
    const ownerUoaSub = requireUoaSubject(actorContext, reply)
    if (!ownerUoaSub) return reply

    try {
      const team = await provisionOnce(
        prisma,
        auditRequestFields(request),
        {
          action: ORG_CREATED_ACTION,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          idempotencyKey: body.idempotencyKey,
          name: body.name,
          slug: body.slug,
          resourceType: 'organization',
        },
        () => createUoaOrganisation({ name: body.name, slug: body.slug, ownerUoaSub }, rosterDeps),
      )
      return createApiResponse(team)
    } catch (error) {
      if (sendProvisioningError(request, reply, error)) return reply
      throw error
    }
  })

  /**
   * Add a team to the organisation the caller is currently in.
   *
   * Owner **or admin**, deliberately wider than the organisation route above.
   * This one is user mode upstream, so UOA applies its own gate on the live
   * membership — owner/admin — and enforces `allow_user_create_team`. Gating
   * locally on owner alone would refuse an admin UOA is willing to serve,
   * making Nessie stricter than the authority it is relaying to; the local
   * check exists to refuse early and identically, not to invent a second
   * policy. The organisation route is owner-only for the opposite reason:
   * backend mode has no upstream gate at all, so its local one is the whole
   * authorization.
   */
  /**
   * Whether an address is free, for the create dialog's address field.
   *
   * Relayed rather than called from the browser because the check is a
   * `/domain/*` read authenticated by the domain hash, which only the server
   * holds. Nessie stores no slug of its own and answers purely from UOA.
   *
   * A failure upstream answers `available: null` — unknown, not unavailable.
   * Blocking creation because a hint could not be fetched would be worse than
   * letting the authoritative write refuse.
   */
  /**
   * Which tenant a hostname means.
   *
   * The admin bundle is one artifact served on every team host, so on a cold
   * load it has to ask which team it is looking at before it can switch onto
   * it. Answering is a `/domain/*` read against UOA, relayed because only the
   * server holds the domain hash.
   *
   * The `Host` header is deliberately not consulted: the hostname arrives as an
   * explicit query parameter from the client that is asking about itself. This
   * route resolves a name to ids and grants nothing — the caller still runs the
   * ordinary team-switch, which is where authorization actually happens.
   */
  /**
   * PUBLIC, and it has to be: this is what a branded landing page renders from,
   * and that page exists for somebody who is not signed in yet. `public: true`
   * opts the route out of the API-wide auth gate, which is otherwise
   * fail-closed for everything.
   *
   * It answers about the ORGANISATION only, and never about a team. That is a
   * structural guarantee rather than a careful branch: this handler has no
   * access to a team id, so no future edit can make it leak one. A client that
   * needs to enter a team asks `/api/hosts/team`, which is authenticated.
   *
   * What it does disclose is that an organisation of a given name exists on
   * this domain, with its display name, mark and palette. That is inherent in
   * giving a tenant a public branded address at all — every one of those is on
   * screen the moment the page renders.
   *
   * The palette is the deliberate exception to "the sign-in screen is instance
   * state, not tenant state"
   * (docs/plans/2026-09-05-organisation-custom-theme.md §4.3). That rule exists
   * because before sign-in nobody knows which organisation the visitor belongs
   * to, and an org admin choosing the shared login screen would be choosing it
   * for every other tenant. On a tenant hostname neither is true: the address
   * names the organisation, and the choice reaches only that organisation's own
   * address. `app.nessie.works` stays neutral, and §4.3 still governs it.
   */
  /**
   * May the edge issue a certificate for this hostname?
   *
   * Caddy's on-demand TLS asks this during the TLS handshake for a hostname it
   * has never seen, and treats **any 2xx as yes**. That is the whole reason
   * this route exists separately from `/api/hosts/resolve`, which answers 200
   * with `kind: null` for a hostname it does not recognise — wired to that, the
   * edge would mint a certificate for every name anyone ever tried.
   *
   * It is also strictly stricter than resolution in a way that matters.
   * `/api/hosts/resolve` verifies only the ORGANISATION label of a team
   * hostname, because a branded page for `<anything>.acme.nessie.works` is
   * harmless — it shows Acme's mark and a sign-in button. A certificate is not
   * harmless: Let's Encrypt allows roughly 50 per registered domain per week,
   * counted across the whole of the base domain, so a made-up team label that
   * earned a certificate would let anybody exhaust issuance for every tenant at
   * once. So this verifies the TEAM.
   *
   * The key is not decoration. The answer is "does this team exist", which this
   * product deliberately keeps behind authentication: `/api/hosts/team` is
   * authenticated and the branded team page never names its team, so that a
   * guessable address cannot be confirmed. Answering that to anyone who asked
   * would give it back through the side door.
   *
   * Failures answer 404, never 5xx: to the edge they mean the same thing, and a
   * 404 gives an unauthenticated caller nothing to tell apart.
   */
  app.get('/api/hosts/tls-check', { config: { public: true } }, async (request, reply) => {
    const refuse = (): FastifyReply => reply.code(404).send()

    // Unset key = closed gate. An install that has not configured this cannot
    // be turned into an existence oracle, and on-demand issuance simply does
    // not happen there.
    if (!tlsCheckKey) return refuse()

    const query = TlsCheckQuerySchema.safeParse(request.query)
    if (!query.success) return refuse()
    if (!timingSafeEquals(query.data.key, tlsCheckKey)) return refuse()

    const parsed = parseTenantHost(query.data.domain, teamHostBaseDomain)
    if (!parsed) return refuse()

    try {
      if (parsed.kind === 'organisation') {
        const organisation = await resolveUoaOrgHost({ orgSlug: parsed.orgSlug }, rosterDeps)
        return organisation ? reply.code(204).send() : refuse()
      }

      const team = await resolveUoaTeamHost(
        { orgSlug: parsed.orgSlug, teamSlug: parsed.teamSlug },
        rosterDeps,
      )
      return team ? reply.code(204).send() : refuse()
    } catch (error) {
      // UOA being unreachable must not mint a certificate. It also must not
      // spend the tenant's first visit on a 500 the edge cannot use.
      if (error instanceof UoaRosterUnavailableError) return refuse()
      throw error
    }
  })

  app.get('/api/hosts/resolve', { config: { public: true } }, async (request, reply) => {
    const query = parseInput(ResolveHostQuerySchema, request.query, reply)
    if (!query) return reply

    const parsed = parseTenantHost(query.host, teamHostBaseDomain)
    if (!parsed) return createApiResponse({ kind: null })

    try {
      const organisation = await resolveUoaOrgHost({ orgSlug: parsed.orgSlug }, rosterDeps)
      if (!organisation) return createApiResponse({ kind: null })

      // The palette is this product's own record, keyed by the UOA id UOA just
      // vouched for — so an unknown organisation cannot reach a local row, and
      // a local row cannot be reached by any name UOA did not resolve first.
      const local = await prisma.organization.findUnique({
        select: { theme: true },
        where: { externalOrgId: organisation.externalOrgId },
      })
      const parsedTheme = OrganizationThemeSchema.safeParse(local?.theme)
      // A palette that no longer validates is dropped rather than sent: the
      // page renders the default instead of a half-applied one.
      const theme = parsedTheme.success ? parsedTheme.data : null

      // Where sign-in happens. A tenant host is never a registered OAuth
      // redirect target — UOA matches redirect URLs byte-for-byte and tenant
      // hostnames are created at runtime — so a signed-out visitor is handed
      // off to the product's canonical origin and returns here afterwards.
      const signInOrigin =
        process.env.NESSIE_ADMIN_PUBLIC_URL ?? process.env.NESSIE_ADMIN_ORIGIN ?? null

      return createApiResponse({
        kind: parsed.kind,
        organisation: { ...organisation, theme },
        signInOrigin,
      })
    } catch (error) {
      if (error instanceof UoaRosterUnavailableError) {
        return createApiResponse({ kind: null })
      }
      throw error
    }
  })

  /**
   * The ids behind a team hostname, for a caller who is signed in.
   *
   * Split from the public resolver deliberately: knowing that
   * `design.acme.nessie.works` maps to a particular team is not something an
   * anonymous visitor needs, and keeping it on an authenticated route means the
   * public one cannot grow into leaking it.
   *
   * Resolving is still not authorization. These ids only let the client run the
   * ordinary team switch, which re-checks live membership and fails closed for
   * a team this person is not in.
   */
  app.get('/api/hosts/team', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = parseInput(ResolveHostQuerySchema, request.query, reply)
    if (!query) return reply

    const parsed = parseTenantHost(query.host, teamHostBaseDomain)
    if (!parsed || parsed.kind !== 'team') return createApiResponse({ team: null })

    try {
      const team = await resolveUoaTeamHost(
        { orgSlug: parsed.orgSlug, teamSlug: parsed.teamSlug },
        rosterDeps,
      )
      return createApiResponse({ team })
    } catch (error) {
      if (error instanceof UoaRosterUnavailableError) {
        return createApiResponse({ team: null })
      }
      throw error
    }
  })

  /**
   * Where a team or organisation lives — its hostname, built from UOA's labels.
   *
   * The inverse of `/api/hosts/resolve`: that turns a hostname into ids, this
   * turns an id into a hostname. Nessie stores no slug (the labels belong to
   * UOA), so a team picker could switch onto a team but had no way to say
   * where it lives, which is what left the address bar stale after a switch.
   *
   * Answers `{ url: null }` rather than failing when this deployment does not
   * route tenants by hostname, so a caller can ask unconditionally and simply
   * get nothing back on an install that has not opted in.
   */
  app.get('/api/hosts/address', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = parseInput(AddressQuerySchema, request.query, reply)
    if (!query) return reply
    if (!teamHostBaseDomain) return createApiResponse({ url: null })

    try {
      if (query.teamId) {
        const address = await resolveUoaTeamAddress({ teamId: query.teamId }, rosterDeps)
        return createApiResponse({
          url: address
            ? `https://${address.teamSlug}.${address.orgSlug}.${teamHostBaseDomain}`
            : null,
        })
      }

      if (query.orgId) {
        const address = await resolveUoaOrgAddress({ orgId: query.orgId }, rosterDeps)
        return createApiResponse({
          url: address ? `https://${address.orgSlug}.${teamHostBaseDomain}` : null,
        })
      }

      return createApiResponse({ url: null })
    } catch (error) {
      if (error instanceof UoaRosterUnavailableError) {
        return createApiResponse({ url: null })
      }
      throw error
    }
  })

  app.get('/api/teams/slug-available', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const query = parseInput(SlugAvailableQuerySchema, request.query, reply)
    if (!query) return reply

    try {
      const result = await checkUoaSlugAvailability(
        {
          slug: query.slug,
          scope: query.scope,
          ...(query.orgId ? { orgId: query.orgId } : {}),
        },
        rosterDeps,
      )
      return createApiResponse(result)
    } catch (error) {
      if (
        error instanceof UoaRosterUnavailableError ||
        error instanceof UoaRosterRejectedError
      ) {
        return createApiResponse({ available: null })
      }
      throw error
    }
  })

  app.post('/api/teams/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!isAdminActor(actorContext)) {
      sendApiError(
        reply,
        403,
        'FORBIDDEN',
        'Only organisation owners and admins can create a team',
      )
      return reply
    }
    const body = parseInput(CreateOrganizationBodySchema, request.body, reply)
    if (!body) return reply

    const team = await resolveUoaRosterTeam(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
    })
    if (!team) {
      sendApiError(
        reply,
        404,
        'TEAM_NOT_LINKED',
        'This team is not linked to an UnlikeOtherAI team',
      )
      return reply
    }

    try {
      const created = await provisionOnce(
        prisma,
        auditRequestFields(request),
        {
          action: TEAM_CREATED_ACTION,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          idempotencyKey: body.idempotencyKey,
          name: body.name,
          slug: body.slug,
          resourceType: 'team',
        },
        () => createUoaTeamTeam(
          team,
          { name: body.name, slug: body.slug },
          withUoaRosterSubjectAssertion(
            team,
            actorContext.actionContext.uoaIdentity,
            rosterDeps,
          ),
        ),
      )
      return createApiResponse(created)
    } catch (error) {
      if (sendProvisioningError(request, reply, error)) return reply
      throw error
    }
  })
}
