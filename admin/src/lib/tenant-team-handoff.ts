/**
 * Carrying "open this team" across an origin, for the teams that have no
 * address of their own.
 *
 * A team's hostname only exists when this deployment can resolve it, and that
 * is narrower than the teams a person belongs to. `/api/hosts/resolve`,
 * `/api/hosts/tls-check` and `/api/hosts/address` all read UOA's `/domain/*`
 * routes, which are scoped to this product's own client domain
 * (`UOA_DOMAIN`) — so an organisation a person belongs to but which was
 * founded on another product's domain has no portal, no team address, and no
 * certificate. `<team>.<that org>.nessie.works` does not complete a TLS
 * handshake at all, which is why a link built from UOA's directory labels
 * alone is a dead link rather than a shortcut.
 *
 * The canonical origin can serve every team, so that is where those switches
 * go — and this is what tells it *which* team, instead of dropping somebody on
 * whatever team their session was last on. That drop was the whole of the
 * "known gap" in docs/standards/team-hosts.md.
 *
 * **These ids are a request, never a grant.** Exactly like a tenant hostname
 * (docs/standards/team-hosts.md, "Resolution is a lookup, never an
 * authorization"), the receiving end runs the ordinary
 * `POST /api/auth/uoa/team`, which re-checks live membership and fails closed.
 * Somebody hand-writing another tenant's ids into this URL gets their own
 * session and a refused switch. Nothing here is signed for the same reason
 * nothing about a hostname is: there is nothing to forge.
 */

export const TEAM_HANDOFF_ORG_PARAM = 'switchOrg'
export const TEAM_HANDOFF_TEAM_PARAM = 'switchTeam'

export type TeamHandoffTarget = {
  organizationId: string
  teamId: string
}

/**
 * The shape an id has to have to be worth sending to the switch.
 *
 * Not a security boundary — the switch is — but it keeps a pasted URL, a
 * truncated copy or a probe from becoming a request, and it is the same
 * conservative label test the hostname parser applies.
 */
const isIdLike = (value: string): boolean =>
  value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)

/**
 * The same address, asking for a team, or null when it cannot be asked for.
 *
 * Takes a complete href rather than an origin so the caller keeps deciding
 * where the landing is; this only adds the question.
 */
export const withTeamHandoff = (
  href: string,
  target: TeamHandoffTarget | null,
): string | null => {
  if (!target || !isIdLike(target.organizationId) || !isIdLike(target.teamId)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  url.searchParams.set(TEAM_HANDOFF_ORG_PARAM, target.organizationId)
  url.searchParams.set(TEAM_HANDOFF_TEAM_PARAM, target.teamId)
  return url.href
}

/** The target a handoff URL is asking for, or null when it is not asking. */
export const parseTeamHandoff = (currentUrl: string): TeamHandoffTarget | null => {
  let params: URLSearchParams
  try {
    params = new URL(currentUrl).searchParams
  } catch {
    return null
  }
  const organizationId = params.get(TEAM_HANDOFF_ORG_PARAM)?.trim() ?? ''
  const teamId = params.get(TEAM_HANDOFF_TEAM_PARAM)?.trim() ?? ''
  if (!isIdLike(organizationId) || !isIdLike(teamId)) return null
  return { organizationId, teamId }
}

/**
 * The same address with the handoff spent.
 *
 * The receiving end reloads rather than routing: a switch replaces the whole
 * tenant context, and a fresh document is the one thing guaranteed to hold no
 * query cached under the previous team. Stripping the parameters first is what
 * stops that reload asking for the switch again.
 */
export const teamHandoffSpentHref = (currentUrl: string): string => {
  const url = new URL(currentUrl)
  url.searchParams.delete(TEAM_HANDOFF_ORG_PARAM)
  url.searchParams.delete(TEAM_HANDOFF_TEAM_PARAM)
  return url.href
}
