import type { LandingTeam } from '@nessie/schemas'

export type { LandingTeam }

export const LANDING_TEAMS_PATH = '/api/auth/landing-teams'

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * One entry of the API's answer, or null when it is not drawable.
 *
 * A hand-written guard rather than `@nessie/schemas`' zod schema, which would
 * pull the whole schemas bundle into the public landing for five fields. The
 * API validates the response against that schema before it sends it.
 */
const toLandingTeam = (value: unknown): LandingTeam | null => {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (!isNonEmptyString(entry.label) || !isHttpUrl(entry.href) || typeof entry.active !== 'boolean') {
    return null
  }
  return {
    label: entry.label,
    ...(isNonEmptyString(entry.orgName) ? { orgName: entry.orgName } : {}),
    ...(isHttpUrl(entry.avatarImageUrl) ? { avatarImageUrl: entry.avatarImageUrl } : {}),
    active: entry.active,
    href: entry.href,
  }
}

/**
 * The teams the visitor is signed into, read from the API with the visitor's
 * own refresh cookie (HttpOnly, sent by the browser; this page never sees it).
 *
 * Every failure — signed out, network, a refused origin, an unexpected body —
 * is an empty list: the landing's section then renders nothing and the rest
 * of the page is untouched.
 */
export const fetchLandingTeams = async ({
  apiOrigin,
  fetchImpl = fetch,
  signal,
}: {
  apiOrigin: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<LandingTeam[]> => {
  try {
    const response = await fetchImpl(new URL(LANDING_TEAMS_PATH, apiOrigin).href, {
      cache: 'no-store',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { data?: { teams?: unknown } }
    const teams = body.data?.teams
    if (!Array.isArray(teams)) return []
    return teams.map(toLandingTeam).filter((team): team is LandingTeam => team !== null)
  } catch {
    return []
  }
}
