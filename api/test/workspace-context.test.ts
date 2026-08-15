import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { materializeUoaWorkspaceSwitch } from '../src/services/uoa-workspace-switch.js'
import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'
import type { ExternalAuthWorkspace } from '../src/services/identity-display.js'

// Minimal in-memory Prisma fake covering exactly the operations
// resolveUoaWorkspaceContext performs when the shared org already exists (the
// common runtime path — the bootstrap branch is exercised by the seed tests).
// Stateful so "same workspace → same team" / "different workspace → different
// team" are meaningful assertions.
type Org = { id: string; createdAt: number }
type User = {
  id: string
  email: string
  uoaSub: string | null
  displayName: string
  avatarUrl: string | null
}
type Project = { id: string; name: string; organizationId: string; createdAt: number }
type Team = {
  id: string
  name: string
  projectId: string
  externalWorkspaceId: string | null
  externalOrgId: string | null
  createdAt: number
}
type Channel = { id: string; teamId: string; visibility: string; createdAt: number }
type OrgMember = { organizationId: string; userId: string; role: string }
type ProjectMember = { projectId: string; userId: string; role: string }
type TeamMember = { teamId: string; userId: string; role: string; createdAt: number }
type ChannelMember = { channelId: string; userId: string }

const makeFake = (seed?: { organizationId?: string; withDefaultTeam?: boolean }) => {
  let clock = 0
  const tick = () => ++clock

  const orgs: Org[] = []
  const users: User[] = []
  const projects: Project[] = []
  const teams: Team[] = []
  const channels: Channel[] = []
  const orgMembers: OrgMember[] = []
  const projectMembers: ProjectMember[] = []
  const teamMembers: TeamMember[] = []
  const channelMembers: ChannelMember[] = []
  const boardColumns: Array<Record<string, unknown>> = []

  let defaultTeamId: string | null = null
  if (seed?.organizationId) {
    orgs.push({ id: seed.organizationId, createdAt: tick() })
    if (seed.withDefaultTeam) {
      const project: Project = {
        id: randomUUID(),
        name: 'Default Project',
        organizationId: seed.organizationId,
        createdAt: tick(),
      }
      projects.push(project)
      const team: Team = {
        id: randomUUID(),
        name: 'Default Team',
        projectId: project.id,
        externalWorkspaceId: null,
        externalOrgId: null,
        createdAt: tick(),
      }
      teams.push(team)
      channels.push({ id: randomUUID(), teamId: team.id, visibility: 'public', createdAt: tick() })
      defaultTeamId = team.id
    }
  }

  const byCreatedAsc = <T extends { createdAt: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => a.createdAt - b.createdAt)

  const client = {
    organization: {
      findFirst: async () => byCreatedAsc(orgs)[0] ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        orgs.find((o) => o.id === where.id) ?? null,
    },
    user: {
      findUnique: async ({
        where,
      }: {
        where: { email?: string; id?: string; uoaSub?: string }
      }) => {
        const found = users.find(
          (u) =>
            (where.email !== undefined && u.email === where.email)
            || (where.id !== undefined && u.id === where.id)
            || (where.uoaSub !== undefined && u.uoaSub === where.uoaSub),
        )
        return found ? { ...found } : null
      },
      create: async ({
        data,
      }: {
        data: { email: string; displayName: string; avatarUrl?: string; uoaSub?: string }
      }) => {
        const row: User = {
          id: randomUUID(),
          email: data.email,
          uoaSub: data.uoaSub ?? null,
          displayName: data.displayName,
          avatarUrl: data.avatarUrl ?? null,
        }
        users.push(row)
        return { id: row.id }
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: { uoaSub?: string; displayName?: string }
      }) => {
        const row = users.find((u) => u.id === where.id)
        if (!row) {
          throw new Error('user.update: no row')
        }
        if (data.uoaSub !== undefined) row.uoaSub = data.uoaSub
        if (data.displayName !== undefined) row.displayName = data.displayName
        return { id: row.id }
      },
      count: async () => users.length,
    },
    project: {
      create: async ({ data }: { data: { name: string; organizationId: string } }) => {
        const row: Project = {
          id: randomUUID(),
          name: data.name,
          organizationId: data.organizationId,
          createdAt: tick(),
        }
        projects.push(row)
        return { id: row.id }
      },
    },
    boardColumn: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        boardColumns.push(...data)
        return { count: data.length }
      },
    },
    team: {
      findUnique: async ({ where }: { where: { externalWorkspaceId: string } }) => {
        const found = teams.find((t) => t.externalWorkspaceId === where.externalWorkspaceId)
        if (!found) {
          return null
        }
        const project = projects.find((p) => p.id === found.projectId)!
        return {
          externalOrgId: found.externalOrgId,
          externalWorkspaceId: found.externalWorkspaceId,
          id: found.id,
          projectId: found.projectId,
          project: { organizationId: project.organizationId },
        }
      },
      findFirst: async () => {
        const found = byCreatedAsc(teams)[0]
        return found ? { id: found.id, projectId: found.projectId } : null
      },
      create: async ({
        data,
      }: {
        data: { name: string; projectId: string; externalWorkspaceId?: string; externalOrgId?: string | null }
      }) => {
        const row: Team = {
          id: randomUUID(),
          name: data.name,
          projectId: data.projectId,
          externalWorkspaceId: data.externalWorkspaceId ?? null,
          externalOrgId: data.externalOrgId ?? null,
          createdAt: tick(),
        }
        teams.push(row)
        return { id: row.id }
      },
    },
    channel: {
      findFirst: async ({ where }: { where: { teamId: string; visibility: string } }) => {
        const found = byCreatedAsc(
          channels.filter((c) => c.teamId === where.teamId && c.visibility === where.visibility),
        )[0]
        return found ? { id: found.id } : null
      },
      create: async ({ data }: { data: { teamId: string; visibility: string } }) => {
        const row: Channel = {
          id: randomUUID(),
          teamId: data.teamId,
          visibility: data.visibility,
          createdAt: tick(),
        }
        channels.push(row)
        return { id: row.id }
      },
    },
    organizationMember: {
      upsert: async ({
        where,
        create,
      }: {
        where: { organizationId_userId: { organizationId: string; userId: string } }
        create: { organizationId: string; userId: string; role: string }
      }) => {
        const key = where.organizationId_userId
        const existing = orgMembers.find(
          (m) => m.organizationId === key.organizationId && m.userId === key.userId,
        )
        if (!existing) {
          orgMembers.push({ ...create })
        }
        return {}
      },
      findUnique: async ({
        where,
      }: {
        where: { organizationId_userId: { organizationId: string; userId: string } }
      }) => {
        const key = where.organizationId_userId
        const found = orgMembers.find(
          (m) => m.organizationId === key.organizationId && m.userId === key.userId,
        )
        return found ? { role: found.role } : null
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { organizationId: string; userId: string }
        data: { role: string }
      }) => {
        const rows = orgMembers.filter(
          (m) => m.organizationId === where.organizationId && m.userId === where.userId,
        )
        for (const row of rows) row.role = data.role
        return { count: rows.length }
      },
    },
    projectMember: {
      upsert: async ({
        where,
        create,
      }: {
        where: { projectId_userId: { projectId: string; userId: string } }
        create: { projectId: string; userId: string; role: string }
      }) => {
        const key = where.projectId_userId
        if (!projectMembers.find((m) => m.projectId === key.projectId && m.userId === key.userId)) {
          projectMembers.push({ ...create })
        }
        return {}
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { projectId: string; userId: string }
        data: { role: string }
      }) => {
        const rows = projectMembers.filter(
          (m) => m.projectId === where.projectId && m.userId === where.userId,
        )
        for (const row of rows) row.role = data.role
        return { count: rows.length }
      },
    },
    teamMember: {
      upsert: async ({
        where,
        create,
      }: {
        where: { teamId_userId: { teamId: string; userId: string } }
        create: { teamId: string; userId: string; role: string }
      }) => {
        const key = where.teamId_userId
        if (!teamMembers.find((m) => m.teamId === key.teamId && m.userId === key.userId)) {
          teamMembers.push({ ...create, createdAt: tick() })
        }
        return {}
      },
      findFirst: async ({ where }: { where: { userId: string } }) => {
        const found = byCreatedAsc(teamMembers.filter((m) => m.userId === where.userId))[0]
        if (!found) {
          return null
        }
        const team = teams.find((t) => t.id === found.teamId)!
        return { teamId: found.teamId, team: { projectId: team.projectId } }
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { teamId: string; userId: string }
        data: { role: string }
      }) => {
        const rows = teamMembers.filter(
          (m) => m.teamId === where.teamId && m.userId === where.userId,
        )
        for (const row of rows) row.role = data.role
        return { count: rows.length }
      },
    },
    channelMember: {
      upsert: async ({
        where,
        create,
      }: {
        where: { channelId_userId: { channelId: string; userId: string } }
        create: { channelId: string; userId: string }
      }) => {
        const key = where.channelId_userId
        if (!channelMembers.find((m) => m.channelId === key.channelId && m.userId === key.userId)) {
          channelMembers.push({ ...create })
        }
        return {}
      },
    },
    // Two raw callers reach this fake. `pg_advisory_xact_lock` arrives as a
    // Prisma.Sql object (no template strings) and is a no-op here; the active
    // owner lock arrives as a tagged template and must answer truthfully, or
    // the last-owner floor in the role projection is never exercised.
    $queryRaw: async (strings: unknown, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? (strings as string[]).join('?') : ''
      if (!sql.includes('organization_members')) {
        return []
      }
      const organizationId = values[0] as string
      return orgMembers
        .filter((m) => m.organizationId === organizationId && m.role === 'owner')
        .map((m) => ({ user_id: m.userId }))
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  }

  return {
    client: client as unknown as PrismaClient,
    defaultTeamId,
    state: {
      orgs,
      users,
      projects,
      teams,
      channels,
      orgMembers,
      projectMembers,
      teamMembers,
      channelMembers,
    },
  }
}

const identityFor = (email: string, workspace?: ExternalAuthWorkspace, uoaSub?: string) => ({
  email,
  displayName: 'Test User',
  workspace,
  ...(uoaSub ? { uoaSub } : {}),
})

const workspace = (activeTeamId: string, role = 'member'): ExternalAuthWorkspace => ({
  activeOrgId: 'uoa-org-1',
  activeTeamId,
  teamIds: [activeTeamId],
  teamRoles: { [activeTeamId]: role },
})

test('auto-provisions a new team bound to the selected UOA workspace', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const ctx = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-backend')))

  assert.ok(ctx)
  assert.equal(ctx!.organizationId, orgId)
  const team = state.teams.find((t) => t.id === ctx!.teamId)
  assert.equal(team?.externalWorkspaceId, 'ws-backend')
  assert.equal(team?.externalOrgId, 'uoa-org-1')
  // UOA said `member` for this workspace, and a verified claim outranks the
  // first-materializer rule — the local row is a projection, not a local grant.
  assert.equal(state.teamMembers.find((m) => m.teamId === ctx!.teamId)?.role, 'member')
  // A #general channel is created and the user joins it.
  assert.equal(state.channels.length, 1)
  assert.equal(state.channelMembers.length, 1)
})

test('auto-provisions the sole UOA team when the chooser omits active', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const soleWorkspace: ExternalAuthWorkspace = {
    orgId: 'uoa-org-only',
    orgRole: 'owner',
    teamIds: ['ws-only'],
    teamRoles: { 'ws-only': 'owner' },
  }

  const ctx = await resolveUoaWorkspaceContext(
    client,
    identityFor('a@x.com', soleWorkspace),
  )

  assert.ok(ctx)
  const team = state.teams.find((item) => item.id === ctx!.teamId)
  assert.equal(team?.externalWorkspaceId, 'ws-only')
  assert.equal(team?.externalOrgId, 'uoa-org-only')
})

test('two different workspaces resolve to two different Nessie teams (isolated environments)', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const backend = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-backend')))
  const design = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-design')))

  assert.ok(backend && design)
  assert.notEqual(backend!.teamId, design!.teamId)
  assert.notEqual(backend!.projectId, design!.projectId)
  assert.equal(state.teams.length, 2)
})

test('the same workspace resolves to the same team for a second user (shared environment)', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const first = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-shared', 'owner')))
  const second = await resolveUoaWorkspaceContext(client, identityFor('b@x.com', workspace('ws-shared', 'member')))

  assert.ok(first && second)
  assert.equal(first!.teamId, second!.teamId)
  assert.equal(state.teams.length, 1)
  // Both users are members of the one workspace team.
  assert.equal(state.teamMembers.filter((m) => m.teamId === first!.teamId).length, 2)
})

test('rejects an existing team bound to the same team id under another external org', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const first = await resolveUoaWorkspaceContext(
    client,
    identityFor('owner@x.com', workspace('ws-shared', 'owner')),
  )
  assert.ok(first)
  const boundTeam = state.teams.find((team) => team.id === first.teamId)
  assert.ok(boundTeam)
  boundTeam.externalOrgId = 'different-uoa-org'
  const projectCount = state.projects.length

  await assert.rejects(
    resolveUoaWorkspaceContext(
      client,
      identityFor('attacker@x.com', workspace('ws-shared')),
    ),
    /conflict with an existing workspace binding/,
  )
  assert.equal(state.projects.length, projectCount)
  assert.equal(state.users.some((user) => user.email === 'attacker@x.com'), false)
})

test('no workspace selection falls back to the user\'s existing team (legacy behaviour)', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  // First login materialises a workspace; a later login with no workspace claim
  // must land the same user back in that existing team, not create a new one.
  const first = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-only')))
  const again = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', undefined))

  assert.ok(first && again)
  assert.equal(again!.teamId, first!.teamId)
  assert.equal(state.teams.length, 1)
})

test('a brand-new user with no workspace claim lands in the default team (non-UOA OIDC)', async () => {
  const orgId = randomUUID()
  const { client, defaultTeamId } = makeFake({ organizationId: orgId, withDefaultTeam: true })

  const ctx = await resolveUoaWorkspaceContext(client, identityFor('new@x.com', undefined))

  assert.ok(ctx)
  assert.equal(ctx!.teamId, defaultTeamId)
})

test('an existing workspace maps the UOA team role to the Nessie member role', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  // Owner materialises the workspace; a later admin joins with role mapped admin.
  await resolveUoaWorkspaceContext(client, identityFor('owner@x.com', workspace('ws-eng', 'owner')))
  const adminCtx = await resolveUoaWorkspaceContext(client, identityFor('admin@x.com', workspace('ws-eng', 'admin')))

  assert.ok(adminCtx)
  const adminMembership = state.teamMembers.find(
    (m) => m.teamId === adminCtx!.teamId && m.userId === adminCtx!.userId,
  )
  assert.equal(adminMembership?.role, 'admin')
})

test('workspace switch materialization uses the authoritative target role and is idempotent', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const target = { organizationId: 'uoa-org-1', teamId: 'ws-target' }
  await resolveUoaWorkspaceContext(
    client,
    identityFor('owner@x.com', workspace(target.teamId, 'owner')),
  )
  const source = await resolveUoaWorkspaceContext(
    client,
    identityFor('switcher@x.com', workspace('ws-source', 'member'), 'uoa-user-switcher'),
  )
  assert.ok(source)

  const materialize = () => materializeUoaWorkspaceSwitch(client, {
    identity: {
      displayName: 'Switching Admin',
      email: 'switcher@x.com',
      externalSubject: 'uoa-user-switcher',
      uoaTokenVersion: 4,
      workspace: workspace(target.teamId, 'admin'),
    },
    target,
    userId: source!.userId,
  })
  await materialize()
  await materialize()

  const targetTeam = state.teams.find(
    (team) => team.externalWorkspaceId === target.teamId,
  )
  assert.ok(targetTeam)
  const memberships = state.teamMembers.filter(
    (member) => member.teamId === targetTeam.id && member.userId === source!.userId,
  )
  assert.equal(memberships.length, 1)
  assert.equal(memberships[0]?.role, 'admin')
})

test('a UOA login resolves the principal by subject even after an email change', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const first = await resolveUoaWorkspaceContext(
    client,
    identityFor('old@x.com', workspace('ws-eng'), 'uoa-sub-stable'),
  )
  // UOA renamed the address; the stable subject still finds the same person.
  const second = await resolveUoaWorkspaceContext(
    client,
    identityFor('renamed@x.com', workspace('ws-eng'), 'uoa-sub-stable'),
  )

  assert.ok(first && second)
  assert.equal(second!.userId, first!.userId)
  assert.equal(state.users.length, 1)
})

test('a UOA login adopts a pre-subject email row exactly once', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  // A row created before subject keying (or by a generic OIDC login).
  const legacy = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-eng')))
  assert.ok(legacy)
  assert.equal(state.users[0]?.uoaSub, null)

  const adopted = await resolveUoaWorkspaceContext(
    client,
    identityFor('a@x.com', workspace('ws-eng'), 'uoa-sub-adopted'),
  )

  assert.ok(adopted)
  assert.equal(adopted!.userId, legacy!.userId)
  assert.equal(state.users.length, 1)
  assert.equal(state.users[0]?.uoaSub, 'uoa-sub-adopted')
})

test('a UOA login for an email bound to a different subject fails closed', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const bound = await resolveUoaWorkspaceContext(
    client,
    identityFor('a@x.com', workspace('ws-eng'), 'uoa-sub-original'),
  )
  assert.ok(bound)
  const membershipCount = state.teamMembers.length

  await assert.rejects(
    resolveUoaWorkspaceContext(
      client,
      identityFor('a@x.com', workspace('ws-eng'), 'uoa-sub-impostor'),
    ),
    (error: Error) => error.name === 'UoaSubjectConflictError',
  )
  // Never taken over, never duplicated, no membership writes for the impostor.
  assert.equal(state.users.length, 1)
  assert.equal(state.users[0]?.uoaSub, 'uoa-sub-original')
  assert.equal(state.teamMembers.length, membershipCount)
})

test('a non-UOA login keeps email keying and never claims a subject', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId, withDefaultTeam: true })

  const uoaCtx = await resolveUoaWorkspaceContext(
    client,
    identityFor('a@x.com', workspace('ws-eng'), 'uoa-sub-1'),
  )
  // A generic OIDC login for the same address still resolves by email
  // (unchanged behaviour) and does not touch the stored subject.
  const genericCtx = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', undefined))

  assert.ok(uoaCtx && genericCtx)
  assert.equal(genericCtx!.userId, uoaCtx!.userId)
  assert.equal(state.users[0]?.uoaSub, 'uoa-sub-1')

  const fresh = await resolveUoaWorkspaceContext(client, identityFor('fresh@x.com', undefined))
  assert.ok(fresh)
  assert.equal(state.users.find((u) => u.email === 'fresh@x.com')?.uoaSub, null)
})

test('workspace switch materialization refuses a user bound to a different subject', async () => {
  const orgId = randomUUID()
  const { client } = makeFake({ organizationId: orgId })
  const source = await resolveUoaWorkspaceContext(
    client,
    identityFor('switcher@x.com', workspace('ws-source', 'member'), 'uoa-sub-real'),
  )
  assert.ok(source)

  await assert.rejects(
    materializeUoaWorkspaceSwitch(client, {
      identity: {
        displayName: 'Switching Admin',
        email: 'switcher@x.com',
        externalSubject: 'uoa-sub-other',
        uoaTokenVersion: 4,
        workspace: workspace('ws-target', 'admin'),
      },
      target: { organizationId: 'uoa-org-1', teamId: 'ws-target' },
      userId: source!.userId,
    }),
    /no longer matches this UnlikeOtherAI session/,
  )
})

// --- UOA is the authority for org/team roles (gap analysis, phase 4) ---------

test('the first materializer still owns a workspace UOA sent no role for', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const roleless: ExternalAuthWorkspace = {
    activeOrgId: 'uoa-org-1',
    activeTeamId: 'ws-silent',
    teamIds: ['ws-silent'],
    teamRoles: {},
  }

  const ctx = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', roleless))

  assert.ok(ctx)
  assert.equal(state.teamMembers.find((m) => m.teamId === ctx!.teamId)?.role, 'owner')
})

test('the org_role claim decides the org membership at first login', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const asAdmin: ExternalAuthWorkspace = {
    ...workspace('ws-eng', 'member'),
    orgRole: 'admin',
  }

  const ctx = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', asAdmin))

  assert.ok(ctx)
  assert.equal(ctx!.orgRole, 'admin')
  assert.equal(
    state.orgMembers.find((m) => m.userId === ctx!.userId)?.role,
    'admin',
  )
})

test('a login with no org_role claim keeps the member default', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const ctx = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', workspace('ws-eng')))

  assert.ok(ctx)
  assert.equal(ctx!.orgRole, 'member')
  assert.equal(state.orgMembers.find((m) => m.userId === ctx!.userId)?.role, 'member')
})

test('a UOA promotion propagates at the next login', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const login = (orgRole: string, teamRole: string) =>
    resolveUoaWorkspaceContext(client, identityFor('a@x.com', {
      ...workspace('ws-eng', teamRole),
      orgRole,
    }, 'uoa-sub-1'))

  const first = await login('member', 'member')
  const second = await login('admin', 'admin')

  assert.ok(first && second)
  assert.equal(second!.userId, first!.userId)
  assert.equal(second!.orgRole, 'admin')
  assert.equal(state.orgMembers.find((m) => m.userId === second!.userId)?.role, 'admin')
  assert.equal(
    state.teamMembers.find((m) => m.teamId === second!.teamId)?.role,
    'admin',
  )
  assert.equal(
    state.projectMembers.find((m) => m.projectId === second!.projectId)?.role,
    'admin',
  )
})

test('a UOA demotion propagates at the next login', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const login = (email: string, sub: string, orgRole: string, teamRole: string) =>
    resolveUoaWorkspaceContext(client, identityFor(email, {
      ...workspace('ws-eng', teamRole),
      orgRole,
    }, sub))

  // Somebody else holds org ownership, so the last-owner floor is not in play.
  await login('boss@x.com', 'uoa-sub-boss', 'owner', 'owner')
  const first = await login('a@x.com', 'uoa-sub-1', 'admin', 'admin')
  const second = await login('a@x.com', 'uoa-sub-1', 'member', 'member')

  assert.ok(first && second)
  assert.equal(second!.userId, first!.userId)
  assert.equal(second!.orgRole, 'member')
  assert.equal(state.orgMembers.find((m) => m.userId === second!.userId)?.role, 'member')
  assert.equal(
    state.teamMembers.find(
      (m) => m.teamId === second!.teamId && m.userId === second!.userId,
    )?.role,
    'member',
  )
})

test('the projection never demotes the last active org owner', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const login = (orgRole: string) =>
    resolveUoaWorkspaceContext(client, identityFor('solo@x.com', {
      ...workspace('ws-eng', 'owner'),
      orgRole,
    }, 'uoa-sub-solo'))

  const first = await login('owner')
  // All UOA workspaces share one local Organization, so a per-UOA-org demotion
  // must not be able to leave this instance with nobody who can administer it.
  const second = await login('member')

  assert.ok(first && second)
  assert.equal(second!.orgRole, 'owner')
  assert.equal(state.orgMembers.find((m) => m.userId === second!.userId)?.role, 'owner')
  // The team role is not owner-floored: only the org invariant is.
  assert.equal(
    state.teamMembers.find((m) => m.userId === second!.userId)?.role,
    'owner',
  )
})

test('a login with no UOA claims leaves an existing role untouched', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const first = await resolveUoaWorkspaceContext(
    client,
    identityFor('a@x.com', { ...workspace('ws-eng', 'admin'), orgRole: 'admin' }, 'uoa-sub-1'),
  )
  assert.ok(first)
  // A generic (non-UOA) OIDC login: no workspace claim at all.
  const again = await resolveUoaWorkspaceContext(client, identityFor('a@x.com', undefined))

  assert.ok(again)
  assert.equal(again!.orgRole, 'admin')
  assert.equal(state.orgMembers.find((m) => m.userId === again!.userId)?.role, 'admin')
  assert.equal(
    state.teamMembers.find((m) => m.teamId === first!.teamId)?.role,
    'admin',
  )
})
