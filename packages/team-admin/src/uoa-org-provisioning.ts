import {
  orgPath,
  requireSettings,
  rosterRequest,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from './uoa-org-request.js'

/**
 * Creating UOA organisations and teams from inside the product, so that
 * founding one costs no second interactive login.
 *
 * This is the write half of `uoa-org-roster.ts` and shares its one `/org/*`
 * seam. Nothing here writes a local row: UOA is the authority for the
 * hierarchy, and the local mirror is materialized later, from what UOA proved
 * in an authenticated switch response (`materializeUoaTeam`). A function
 * in this file therefore returns UOA ids and nothing else — there is
 * deliberately no place to put a local organisation.
 */

/** The UOA team a caller may now switch onto. Both ids come from UOA. */
export type UoaProvisionedTeam = {
  externalOrgId: string
  externalTeamId: string
}

const trimString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

/** The organisation id from a create response, or undefined if unusable. */
const parseOrganisationId = (payload: unknown): string | undefined =>
  trimString(asRecord(payload)?.id)

/**
 * The default team UOA created in the same transaction as the organisation.
 *
 * Optional on purpose. UOA gained this field on 2026-09-02; a deployment
 * running an older build answers without it, and so would any intermediary
 * that reshaped the body. `resolveDefaultTeamId` falls back to a read rather
 * than failing, because by this point the organisation EXISTS and refusing
 * would strand it.
 */
const parseDefaultTeamId = (payload: unknown): string | undefined => {
  const team = asRecord(asRecord(payload)?.defaultTeam)
  return team ? trimString(team.id) : undefined
}

/**
 * The default team of an organisation, from the team list.
 *
 * `isDefault` is UOA's own marker and exactly one team carries it. The
 * single-team shortcut covers the same instant from the other side: an
 * organisation created moments ago has precisely one team, which is that team,
 * even if a future UOA stopped flagging it.
 */
const parseDefaultTeamIdFromList = (payload: unknown): string | undefined => {
  const record = asRecord(payload)
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(payload) ? payload : []
  const teams = rows.flatMap((row) => {
    const team = asRecord(row)
    const id = team ? trimString(team.id) : undefined
    return id ? [{ id, isDefault: team?.isDefault === true }] : []
  })
  return (teams.find((team) => team.isDefault) ?? (teams.length === 1 ? teams[0] : undefined))?.id
}

/**
 * The id of the new organisation's default team.
 *
 * Prefer the create response; fall back to reading the org's teams. The
 * fallback is not a migration shim to delete once UOA is deployed — it is the
 * defensive read for the one failure the primary path cannot see, and it costs
 * one request only when the field is absent.
 */
const resolveDefaultTeamId = async (
  externalOrgId: string,
  createPayload: unknown,
  deps: UoaRosterDeps,
): Promise<string> => {
  const fromCreate = parseDefaultTeamId(createPayload)
  if (fromCreate) return fromCreate

  const listed = parseDefaultTeamIdFromList(await rosterRequest(
    requireSettings(),
    `/org/organisations/${encodeURIComponent(externalOrgId)}/teams`,
    { method: 'GET' },
    deps,
  ))
  if (listed) return listed

  // The organisation exists in UOA and cannot be rolled back. Say so precisely:
  // the caller's recovery is to switch to it once a session refresh has primed
  // the team directory, not to create it again.
  throw new UoaRosterUnavailableError(
    `[uoa] organisation ${externalOrgId} was created but its default team could not be resolved`,
  )
}

/**
 * Create a UOA organisation owned by `ownerUoaSub`, and answer the team to
 * switch onto.
 *
 * **Backend mode, deliberately.** `deps` carries no subject assertion, so UOA
 * authenticates the domain pairing alone — the per-domain hash bearer plus this
 * product's signed config JWT. Two things follow, and both are load-bearing.
 *
 * First, it is the only mode that can work here. A user-mode assertion must
 * name the org and team it is acting on, and immediately after creation those
 * are precisely what is unknown, so an assertion could not make the follow-up
 * read that resolves the default team.
 *
 * Second, backend mode means UOA applies NO per-member role check — the
 * product's own gate is the entire authorization. Callers must therefore
 * re-read the acting member's live role before calling this. It is not checked
 * here because this function has no session to check.
 */
export const createUoaOrganisation = async (
  input: { name: string; slug?: string; ownerUoaSub: string },
  deps: UoaRosterDeps = {},
): Promise<UoaProvisionedTeam> => {
  const settings = requireSettings()
  const backendMode: UoaRosterDeps = { ...deps, subjectAssertion: undefined }

  const payload = await rosterRequest(
    settings,
    '/org/organisations',
    {
      method: 'POST',
      // `slug` omitted lets UOA derive the address from the name; supplied, UOA
      // validates it and refuses with a reason. Nessie stores neither.
      body: {
        name: input.name,
        ...(input.slug ? { slug: input.slug } : {}),
        owner_user_id: input.ownerUoaSub,
      },
    },
    backendMode,
  )

  const externalOrgId = parseOrganisationId(payload)
  if (!externalOrgId) {
    throw new UoaRosterUnavailableError(
      '[uoa] the org API accepted the organisation but returned no id',
    )
  }

  return {
    externalOrgId,
    externalTeamId: await resolveDefaultTeamId(externalOrgId, payload, backendMode),
  }
}

/**
 * Create a further team (UOA team) inside an organisation the caller
 * already belongs to.
 *
 * **User mode, deliberately** — the opposite choice from `createUoaOrganisation`
 * and for the reason that one could not make it: here the route carries an
 * `:orgId` that IS the caller's current organisation, so a subject assertion
 * binds cleanly. Pass one via `withUoaRosterSubjectAssertion(team,
 * identity)`. That buys back everything backend mode gives up — UOA applies its
 * own owner/admin gate on the live membership, enforces
 * `allow_user_create_team`, attributes the audit entry to the person rather
 * than to the domain backend, and rate-limits per user instead of per
 * deployment.
 *
 * `team.externalTeamId` is the caller's CURRENT team, used only to bind
 * the assertion. The new team's id comes back in the response.
 */
export const createUoaTeamTeam = async (
  team: UoaRosterTeam,
  input: { name: string; slug?: string },
  deps: UoaRosterDeps = {},
): Promise<UoaProvisionedTeam> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${orgPath(team)}/teams`,
    {
      method: 'POST',
      // Put the caller in the team they are creating, as its owner, in
      // UOA's own transaction. Without it UOA writes the team row alone, and
      // every entry check — including the service-access confirm the switch
      // grant runs — requires an ACTIVE TeamMember, so the person would create
      // a team they could not open.
      body: { name: input.name, ...(input.slug ? { slug: input.slug } : {}), join_creator: true },
    },
    deps,
  )

  const externalTeamId = trimString(asRecord(payload)?.id)
  if (!externalTeamId) {
    throw new UoaRosterUnavailableError(
      '[uoa] the org API accepted the team but returned no id',
    )
  }
  return { externalOrgId: team.externalOrgId, externalTeamId }
}

/**
 * Whether an address is free, asked of UOA on behalf of somebody typing in a
 * create dialog.
 *
 * Backend mode: this is a `/domain/*` read and the domain hash is the only
 * credential it needs. Nessie holds that server-side, which is the whole reason
 * this is relayed rather than called from the browser.
 *
 * Answers a reason, not a bare boolean, because the field has to say what is
 * wrong. An unreachable UOA is deliberately NOT translated into "unavailable" —
 * the caller treats it as unknown and lets the create attempt be the real
 * answer, since blocking creation on a failed hint would be worse than letting
 * the authoritative write refuse.
 */
export const checkUoaSlugAvailability = async (
  input: { slug: string; scope: 'organisation' | 'team'; orgId?: string; reserved?: string[] },
  deps: UoaRosterDeps = {},
): Promise<{ available: boolean; slug?: string; reason?: string }> => {
  const payload = await rosterRequest(
    requireSettings(),
    '/domain/slug-available',
    {
      method: 'GET',
      query: {
        slug: input.slug,
        scope: input.scope,
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(input.reserved?.length ? { reserved: input.reserved.join(',') } : {}),
      },
    },
    { ...deps, subjectAssertion: undefined },
  )

  const record = asRecord(payload)
  return {
    available: record?.available === true,
    ...(typeof record?.slug === 'string' ? { slug: record.slug } : {}),
    ...(typeof record?.reason === 'string' ? { reason: record.reason } : {}),
  }
}
