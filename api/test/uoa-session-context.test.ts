import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import type { ExternalAuthTeam } from '../src/services/identity-display.js'
import {
  clearUoaTeamDirectoryCache,
  readUoaTeamDirectory,
} from '../src/services/uoa-directory-cache.js'
import {
  advanceUoaLocalSessionBinding,
  advanceUoaLocalSessionBindingInTransaction,
  resolveUoaLocalSessionContext,
  UoaLocalSessionBindingError,
} from '../src/services/uoa-session-context.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const IDENTITY = {
  organizationId: 'uoa-org',
  subject: 'uoa-user',
  teamId: 'uoa-team',
  tokenVersion: 7,
} as const

class FakeBindingPrisma {
  teamAvailable = true
  expectedOrganizationId = IDENTITY.organizationId
  expectedTeamId = IDENTITY.teamId
  link = {
    activeOrgId: IDENTITY.organizationId,
    activeTeamId: IDENTITY.teamId,
    id: '00000000-0000-4000-8000-000000000010',
    metadata: { retained: 'value' },
    status: 'linked',
    uoaSub: IDENTITY.subject,
    uoaTokenVersion: IDENTITY.tokenVersion,
  }
  siblingLinks = [
    {
      id: '00000000-0000-4000-8000-000000000011',
      metadata: { retained: 'sibling-one' },
      productSlug: 'deep-water',
      uoaTokenVersion: IDENTITY.tokenVersion as number | null,
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      metadata: { retained: 'sibling-two' },
      productSlug: 'deepsignal',
      uoaTokenVersion: IDENTITY.tokenVersion as number | null,
    },
  ]

  // Local membership rows, so the UOA role projection can be observed.
  orgRole = 'owner'
  projectRole = 'member'
  teamRole = 'member'
  otherActiveOwnerIds: string[] = []

  // The org row backing the projection's floor decision: per-UOA-org
  // Organizations (externalOrgId set) take the claim as complete; a legacy
  // null-externalOrgId org keeps the last-owner floor.
  organizationExternalOrgId: string | null = IDENTITY.organizationId

  readonly organization = {
    findUnique: async () => ({
      externalOrgId: this.organizationExternalOrgId,
      id: '00000000-0000-4000-8000-000000000040',
    }),
  }

  readonly userAlert = {
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => undefined,
  }

  readonly team = {
    findFirst: async (input: {
      where: {
        externalOrgId: string
        externalTeamId: string
        members: { some: { userId: string } }
        project: { organization: { externalOrgId: string } }
      }
    }) => {
      assert.equal(input.where.externalOrgId, this.expectedOrganizationId)
      assert.equal(input.where.externalTeamId, this.expectedTeamId)
      assert.equal(input.where.members.some.userId, USER_ID)
      // Organizations map 1:1 to UOA organisations: the binding must require
      // the team's Organization to carry the session's external org id, so a
      // team is never reachable through a foreign org.
      assert.equal(
        input.where.project.organization.externalOrgId,
        this.expectedOrganizationId,
      )
      if (!this.teamAvailable) return null
      return {
        id: '00000000-0000-4000-8000-000000000020',
        projectId: '00000000-0000-4000-8000-000000000030',
        project: {
          organizationId: '00000000-0000-4000-8000-000000000040',
          organization: { members: [{ role: this.orgRole }] },
        },
      }
    },
  }

  readonly organizationMember = {
    findUnique: async () => ({ role: this.orgRole }),
    updateMany: async (input: { data: { role: string } }) => {
      this.orgRole = input.data.role
      return { count: 1 }
    },
  }

  readonly projectMember = {
    updateMany: async (input: { data: { role: string } }) => {
      this.projectRole = input.data.role
      return { count: 1 }
    },
  }

  readonly teamMember = {
    updateMany: async (input: { data: { role: string } }) => {
      this.teamRole = input.data.role
      return { count: 1 }
    },
  }

  // The active-owner FOR UPDATE lock behind the projection's last-owner floor.
  async $queryRaw(): Promise<Array<{ user_id: string }>> {
    return [
      ...(this.orgRole === 'owner' ? [{ user_id: USER_ID }] : []),
      ...this.otherActiveOwnerIds.map((user_id) => ({ user_id })),
    ]
  }

  readonly productAccountLink = {
    findUnique: async (input: {
      where: {
        organizationId_userId_productSlug: {
          organizationId: string
          productSlug: string
          userId: string
        }
      }
    }) => {
      assert.deepEqual(input.where.organizationId_userId_productSlug, {
        organizationId: '00000000-0000-4000-8000-000000000040',
        productSlug: 'nessie',
        userId: USER_ID,
      })
      return { ...this.link }
    },
    findMany: async () => [
      { ...this.link, productSlug: 'nessie' },
      ...this.siblingLinks.map((link) => ({ ...link })),
    ],
    updateMany: async (input: {
      where: { id: string }
      data: {
        activeOrgId?: string
        activeTeamId?: string
        metadata?: unknown
        uoaTokenVersion: number
      }
    }) => {
      if (input.where.id === this.link.id) {
        this.link.uoaTokenVersion = input.data.uoaTokenVersion
        if (input.data.activeOrgId) this.link.activeOrgId = input.data.activeOrgId
        if (input.data.activeTeamId) this.link.activeTeamId = input.data.activeTeamId
        if (input.data.metadata) this.link.metadata = input.data.metadata as typeof this.link.metadata
        return { count: 1 }
      }
      for (const link of this.siblingLinks) {
        if (input.where.id !== link.id) continue
        link.uoaTokenVersion = input.data.uoaTokenVersion
        if (input.data.metadata) link.metadata = input.data.metadata as typeof link.metadata
        return { count: 1 }
      }
      return { count: 0 }
    },
  }

  async $transaction<T>(operation: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return operation(this.asClient())
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient
  }
}

test('resolves the exact UOA-bound Nessie team and live role', async () => {
  const fake = new FakeBindingPrisma()

  assert.deepEqual(
    await resolveUoaLocalSessionContext(fake.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    {
      organizationId: '00000000-0000-4000-8000-000000000040',
      projectId: '00000000-0000-4000-8000-000000000030',
      role: 'owner',
      teamId: '00000000-0000-4000-8000-000000000020',
    },
  )
})

test('keeps another team family valid when account-link last-seen metadata changes', async () => {
  const fake = new FakeBindingPrisma()
  fake.link.activeOrgId = 'last-seen-other-org'
  fake.link.activeTeamId = 'last-seen-other-team'

  const context = await resolveUoaLocalSessionContext(fake.asClient(), {
    identity: IDENTITY,
    userId: USER_ID,
  })

  assert.equal(context.teamId, '00000000-0000-4000-8000-000000000020')
})

test('rejects first-membership fallback and stable-link epoch drift', async () => {
  const missingTeam = new FakeBindingPrisma()
  missingTeam.teamAvailable = false
  await assert.rejects(
    resolveUoaLocalSessionContext(missingTeam.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )

  const staleLink = new FakeBindingPrisma()
  staleLink.link.uoaTokenVersion = 6
  await assert.rejects(
    resolveUoaLocalSessionContext(staleLink.asClient(), {
      identity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
})

test('advances every exact first-party link to the same monotonic epoch', async () => {
  const fake = new FakeBindingPrisma()
  const nextIdentity = { ...IDENTITY, tokenVersion: 8 }

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity,
    previousIdentity: IDENTITY,
    userId: USER_ID,
  })

  assert.equal(fake.link.uoaTokenVersion, 8)
  assert.deepEqual(fake.siblingLinks.map((link) => link.uoaTokenVersion), [8, 8])
  assert.equal(context.teamId, '00000000-0000-4000-8000-000000000020')
  assert.deepEqual(
    await resolveUoaLocalSessionContext(fake.asClient(), {
      identity: nextIdentity,
      userId: USER_ID,
    }),
    context,
  )
})

test('concurrent replay accepts an already-advanced epoch', async () => {
  const fake = new FakeBindingPrisma()
  fake.link.uoaTokenVersion = 8
  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
  })

  assert.equal(context.teamId, '00000000-0000-4000-8000-000000000020')
})

// Estate rule: a successor proving the same subject and a non-regressed epoch
// is ADOPTED even when it names a different team, because a drift is how
// a committed switch (or a UOA-side team change) surfaces on the next
// refresh. Refusing made a successful switch look like a logout.
test('an ordinary refresh adopts a successor that drifted to another team', async () => {
  const fake = new FakeBindingPrisma()
  const nextIdentity = {
    ...IDENTITY,
    organizationId: 'uoa-org-drifted',
    teamId: 'uoa-team-drifted',
    tokenVersion: 8,
  }
  fake.expectedOrganizationId = nextIdentity.organizationId
  fake.expectedTeamId = nextIdentity.teamId

  const context = await advanceUoaLocalSessionBindingInTransaction(
    fake.asClient() as never,
    { nextIdentity, previousIdentity: IDENTITY, userId: USER_ID },
  )

  // The local binding is re-derived from the successor's own team and the
  // last-seen metadata follows it.
  assert.equal(fake.link.uoaTokenVersion, 8)
  assert.equal(fake.link.activeOrgId, nextIdentity.organizationId)
  assert.equal(fake.link.activeTeamId, nextIdentity.teamId)
  assert.equal(context.teamId, '00000000-0000-4000-8000-000000000020')
})

test('an adopted team that maps to no local team still fails closed', async () => {
  const fake = new FakeBindingPrisma()
  const nextIdentity = {
    ...IDENTITY,
    organizationId: 'uoa-org-unmapped',
    teamId: 'uoa-team-unmapped',
    tokenVersion: 8,
  }
  fake.expectedOrganizationId = nextIdentity.organizationId
  fake.expectedTeamId = nextIdentity.teamId
  fake.teamAvailable = false

  await assert.rejects(
    advanceUoaLocalSessionBindingInTransaction(
      fake.asClient() as never,
      { nextIdentity, previousIdentity: IDENTITY, userId: USER_ID },
    ),
    UoaLocalSessionBindingError,
  )
})

// The two checks that actually prove identity stay strictly enforced: a
// changed subject or a regressed authentication epoch is never adopted.
test('a changed subject or a regressed epoch is still refused', async () => {
  const changedSubject = new FakeBindingPrisma()
  await assert.rejects(
    advanceUoaLocalSessionBinding(changedSubject.asClient(), {
      nextIdentity: { ...IDENTITY, subject: 'someone-else', tokenVersion: 8 },
      previousIdentity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
  assert.equal(changedSubject.link.uoaTokenVersion, IDENTITY.tokenVersion)

  const regressedEpoch = new FakeBindingPrisma()
  await assert.rejects(
    advanceUoaLocalSessionBinding(regressedEpoch.asClient(), {
      nextIdentity: { ...IDENTITY, tokenVersion: 6 },
      previousIdentity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
  assert.equal(regressedEpoch.link.uoaTokenVersion, IDENTITY.tokenVersion)

  // A drift carrying either violation is refused for that reason, never
  // adopted because the team check is gone.
  const both = new FakeBindingPrisma()
  both.expectedOrganizationId = 'uoa-org-drifted'
  both.expectedTeamId = 'uoa-team-drifted'
  await assert.rejects(
    advanceUoaLocalSessionBinding(both.asClient(), {
      nextIdentity: {
        organizationId: 'uoa-org-drifted',
        subject: 'someone-else',
        teamId: 'uoa-team-drifted',
        tokenVersion: 8,
      },
      previousIdentity: IDENTITY,
      userId: USER_ID,
    }),
    UoaLocalSessionBindingError,
  )
  assert.equal(both.link.uoaTokenVersion, IDENTITY.tokenVersion)
})

test('a rotation caches the refreshed directory and never persists it', async () => {
  clearUoaTeamDirectoryCache()
  const fake = new FakeBindingPrisma()
  const teamDirectory = {
    entries: [{
      organizationId: IDENTITY.organizationId,
      teamId: IDENTITY.teamId,
      label: 'Fresh team',
    }],
    pendingInvites: [],
  }

  await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: IDENTITY,
    previousIdentity: IDENTITY,
    userId: USER_ID,
    teamDirectory,
  })

  assert.deepEqual(readUoaTeamDirectory(USER_ID), teamDirectory)
  assert.deepEqual(fake.link.metadata, { retained: 'value' })
  assert.deepEqual(
    fake.siblingLinks.map((link) => link.metadata),
    [{ retained: 'sibling-one' }, { retained: 'sibling-two' }],
  )
  clearUoaTeamDirectoryCache()
})

// --- UOA roles are re-projected on every rotation (gap analysis, phase 4) ----

const claimsFor = (orgRole: string, teamRole: string): ExternalAuthTeam => ({
  activeOrgId: IDENTITY.organizationId,
  activeTeamId: IDENTITY.teamId,
  orgRole,
  teamIds: [IDENTITY.teamId],
  teamRoles: { [IDENTITY.teamId]: teamRole },
})

test('a refresh projects a UOA demotion onto the local membership', async () => {
  const fake = new FakeBindingPrisma()
  // Somebody else still owns the org, so the last-owner floor is not in play.
  fake.otherActiveOwnerIds = ['00000000-0000-4000-8000-0000000000ff']

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
    team: claimsFor('member', 'member'),
  })

  assert.equal(fake.orgRole, 'member')
  assert.equal(context.role, 'member')
})

test('a refresh projects a UOA promotion onto org, project, and team rows', async () => {
  const fake = new FakeBindingPrisma()
  fake.orgRole = 'member'

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
    team: claimsFor('admin', 'admin'),
  })

  assert.equal(context.role, 'admin')
  assert.equal(fake.orgRole, 'admin')
  assert.equal(fake.projectRole, 'admin')
  assert.equal(fake.teamRole, 'admin')
})

test('a refresh applies a UOA demotion even to the LAST owner of a per-UOA-org org', async () => {
  const fake = new FakeBindingPrisma()

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
    team: claimsFor('member', 'member'),
  })

  // Organizations map 1:1 to UOA organisations, so the verified claim is a
  // complete statement: no last-owner floor for an externalOrgId org.
  assert.equal(fake.orgRole, 'member')
  assert.equal(context.role, 'member')
  assert.equal(fake.teamRole, 'member')
})

test('a refresh keeps the last-owner floor for a legacy null-externalOrgId org', async () => {
  const fake = new FakeBindingPrisma()
  fake.organizationExternalOrgId = null

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
    team: claimsFor('member', 'member'),
  })

  assert.equal(fake.orgRole, 'owner')
  assert.equal(context.role, 'owner')
  // Only the org role is floored; the team role still follows UOA.
  assert.equal(fake.teamRole, 'member')
})

test('a refresh that carries no role claims changes no local role', async () => {
  const fake = new FakeBindingPrisma()
  fake.orgRole = 'admin'
  fake.teamRole = 'admin'

  const context = await advanceUoaLocalSessionBinding(fake.asClient(), {
    nextIdentity: { ...IDENTITY, tokenVersion: 8 },
    previousIdentity: IDENTITY,
    userId: USER_ID,
    team: {
      activeOrgId: IDENTITY.organizationId,
      activeTeamId: IDENTITY.teamId,
      teamIds: [IDENTITY.teamId],
      teamRoles: {},
    },
  })

  assert.equal(context.role, 'admin')
  assert.equal(fake.orgRole, 'admin')
  assert.equal(fake.teamRole, 'admin')
})
