// Team cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

const teamMembersKey = ['teams', 'members'] as const

export const teamKeys = {
  all: ['teams'] as const,
  // Client-only cache-buster for the fixed `/api/team/avatar` URL; nothing
  // fetches it, so it never refetches or resets on its own.
  avatarRevision: ['teams', 'avatar', 'revision'] as const,
  invitations: ['teams', 'invitations'] as const,
  memberCandidates: (search: string) => [...teamMembersKey, 'candidates', search] as const,
  memberRoster: (resource: 'members' | 'invitations') => [...teamMembersKey, resource] as const,
  members: teamMembersKey,
}

export const teamProvisioningKeys = {
  /**
   * Availability of an address being typed into a create dialog.
   *
   * Scoped by destination as well as by label: `design` may be free in one
   * organisation and taken in the next, so an organisation-scoped answer must
   * never be served from another organisation's cache entry.
   */
  slugAvailability: (scope: 'organisation' | 'team', orgId: string, slug: string) =>
    ['slug-available', scope, orgId, slug] as const,
}


export const tenantHostKeys = {
  /**
   * What tenant the browser's current hostname means.
   *
   * Keyed by hostname because that is the whole input, and it cannot change
   * without a navigation — so this is fetched once per host per session.
   */
  resolve: (hostname: string) => ['tenant-host', hostname] as const,
  /** The authenticated half: the ids behind a team hostname. */
  team: (hostname: string) => ['tenant-host', hostname, 'team'] as const,
}
