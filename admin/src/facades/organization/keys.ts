// Organization cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

const organizationMembersKey = ['organization', 'members'] as const

export const organizationKeys = {
  current: ['organization', 'current'] as const,
  invitationTargets: [...organizationMembersKey, 'invitation-targets'] as const,
  memberRoster: (resource: 'members' | 'invitations') =>
    [...organizationMembersKey, resource] as const,
  members: organizationMembersKey,
  memberTeams: (uoaSub?: string) =>
    [...organizationMembersKey, uoaSub ?? 'none', 'teams'] as const,
}
