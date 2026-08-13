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
type User = { id: string; email: string; displayName: string; avatarUrl: string | null }
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
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        const found = users.find(
          (u) => (where.email && u.email === where.email) || (where.id && u.id === where.id),
        )
        return found ? { ...found } : null
      },
      create: async ({ data }: { data: { email: string; displayName: string; avatarUrl?: string } }) => {
        const row: User = {
          id: randomUUID(),
          email: data.email,
          displayName: data.displayName,
          avatarUrl: data.avatarUrl ?? null,
        }
        users.push(row)
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
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  }

  return {
    client: client as unknown as PrismaClient,
    defaultTeamId,
    state: { orgs, users, projects, teams, channels, orgMembers, teamMembers, channelMembers },
  }
}

const identityFor = (email: string, workspace?: ExternalAuthWorkspace) => ({
  email,
  displayName: 'Test User',
  workspace,
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
  // The person who first materialises a workspace owns that team.
  assert.equal(state.teamMembers.find((m) => m.teamId === ctx!.teamId)?.role, 'owner')
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
    identityFor('switcher@x.com', workspace('ws-source', 'member')),
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
