import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { projectUoaRoles } from '../src/services/uoa-roles.js'
import { materializeUoaTeamSwitch } from '../src/services/uoa-team-switch.js'
import { resolveUoaTeamContext } from '../src/services/team-context.js'
import type { ExternalAuthTeam } from '../src/services/identity-display.js'

// Minimal in-memory Prisma fake covering exactly the operations
// resolveUoaTeamContext performs. A UOA login (team claim carrying
// an external org id) resolves-or-creates the per-UOA-org Organization; the
// seeded org stands in for the legacy shared/bootstrap org that the
// no-team fallback still uses. Stateful so "same team → same team" /
// "different org → different Organization" are meaningful assertions.
type Org = { id: string; createdAt: number; externalOrgId: string | null; name: string }
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
  externalTeamId: string | null
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
  const policyRules: Array<Record<string, unknown>> = []
  const policyBindings: Array<Record<string, unknown>> = []
  const linkSyncs: number[] = []

  let defaultTeamId: string | null = null
  if (seed?.organizationId) {
    orgs.push({
      id: seed.organizationId,
      createdAt: tick(),
      externalOrgId: null,
      name: 'Seeded Org',
    })
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
        externalTeamId: null,
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
      findUnique: async ({ where }: { where: { id?: string; externalOrgId?: string } }) =>
        orgs.find((o) =>
          (where.id !== undefined && o.id === where.id)
          || (where.externalOrgId !== undefined && o.externalOrgId === where.externalOrgId),
        ) ?? null,
      create: async ({ data }: { data: { externalOrgId: string; name: string } }) => {
        const row: Org = {
          id: randomUUID(),
          createdAt: tick(),
          externalOrgId: data.externalOrgId,
          name: data.name,
        }
        orgs.push(row)
        return { id: row.id }
      },
      updateMany: async () => ({ count: 0 }),
    },
    policyRule: {
      count: async ({ where }: { where: { organizationId: string } }) =>
        policyRules.filter((r) => r.organizationId === where.organizationId).length,
      findFirst: async () => null,
      // The default seeder writes the set with `createMany({ skipDuplicates })`
      // against the partial unique index on (organization_id, seed_key), then
      // reads the rows back by seed key to attach their bindings. Honour the
      // uniqueness here, or a re-seed reports every default as new.
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0
        for (const row of data) {
          const seedKey = row.seedKey as string | null | undefined
          const duplicate = seedKey != null && policyRules.some((existing) =>
            existing.organizationId === row.organizationId
            && existing.seedKey === seedKey)
          if (duplicate) continue
          policyRules.push({
            id: randomUUID(),
            ...row,
            bindings: [],
            conditions: row.conditions ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          count += 1
        }
        return { count }
      },
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; seedKey?: { in: string[] } }
      }) =>
        policyRules.filter((r) =>
          r.organizationId === where.organizationId
          && (where.seedKey === undefined
            || where.seedKey.in.includes(r.seedKey as string))),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const bindings = (data.bindings as
          | { create: Array<Record<string, unknown>> }
          | undefined)?.create ?? []
        const row = {
          id: randomUUID(),
          ...data,
          conditions: data.conditions ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          bindings: bindings.map((b) => ({ id: randomUUID(), ...b })),
        }
        policyRules.push(row)
        return row
      },
    },
    policyBinding: {
      // Unique on (policy_rule_id, actor_type, actor_id), which is what makes
      // the seeder's second pass idempotent.
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        let count = 0
        for (const row of data) {
          const duplicate = policyBindings.some((existing) =>
            existing.policyRuleId === row.policyRuleId
            && existing.actorType === row.actorType
            && existing.actorId === row.actorId)
          if (duplicate) continue
          policyBindings.push({ id: randomUUID(), ...row })
          count += 1
        }
        return { count }
      },
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
    board: {
      count: async () => 0,
      // The default board is one nested create, so the columns arrive under
      // `columns.create` rather than as their own `createMany`.
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const columns = (data.columns as { create?: Array<Record<string, unknown>> })?.create
        if (columns) boardColumns.push(...columns)
        return { id: `board-${boardColumns.length}` }
      },
    },
    team: {
      findUnique: async ({ where }: { where: { externalTeamId: string } }) => {
        const found = teams.find((t) => t.externalTeamId === where.externalTeamId)
        if (!found) {
          return null
        }
        const project = projects.find((p) => p.id === found.projectId)!
        return {
          externalOrgId: found.externalOrgId,
          externalTeamId: found.externalTeamId,
          id: found.id,
          projectId: found.projectId,
          project: { organizationId: project.organizationId },
        }
      },
      findFirst: async ({ where }: {
        where?: { project?: { organizationId?: string } }
      } = {}) => {
        const scoped = teams.filter((t) => {
          if (where?.project?.organizationId === undefined) return true
          const project = projects.find((p) => p.id === t.projectId)
          return project?.organizationId === where.project.organizationId
        })
        const found = byCreatedAsc(scoped)[0]
        return found ? { id: found.id, projectId: found.projectId } : null
      },
      create: async ({
        data,
      }: {
        data: { name: string; projectId: string; externalTeamId?: string; externalOrgId?: string | null }
      }) => {
        const row: Team = {
          id: randomUUID(),
          name: data.name,
          projectId: data.projectId,
          externalTeamId: data.externalTeamId ?? null,
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
      count: async ({ where }: { where: { organizationId: string } }) =>
        orgMembers.filter((m) => m.organizationId === where.organizationId).length,
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
      findFirst: async ({ where }: {
        where: { userId: string; team?: { project?: { organizationId?: string } } }
      }) => {
        const found = byCreatedAsc(teamMembers.filter((m) => {
          if (m.userId !== where.userId) return false
          if (where.team?.project?.organizationId === undefined) return true
          const team = teams.find((t) => t.id === m.teamId)
          const project = projects.find((p) => p.id === team?.projectId)
          return project?.organizationId === where.team.project.organizationId
        }))[0]
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
    // Raw callers reaching this fake: `pg_advisory_xact_lock` arrives as a
    // Prisma.Sql object and is a no-op here; the active owner lock arrives as
    // a tagged template and must answer truthfully, or the last-owner floor in
    // the role projection is never exercised; the first-party products read of
    // `syncUoaProductAccountLinks` (a Prisma.Sql object) answers the `nessie`
    // row so a team switch can sync the target org's links.
    $queryRaw: async (strings: unknown, ...values: unknown[]) => {
      const sql = Array.isArray(strings)
        ? (strings as string[]).join('?')
        : String((strings as { sql?: string })?.sql ?? '')
      if (sql.includes('integrated_products')) {
        return [{ slug: 'nessie' }]
      }
      if (!sql.includes('organization_members')) {
        return []
      }
      const organizationId = values[0] as string
      return orgMembers
        .filter((m) => m.organizationId === organizationId && m.role === 'owner')
        .map((m) => ({ user_id: m.userId }))
    },
    // The account-link upsert of `syncUoaProductAccountLinks` (team
    // switch → target-org link sync). Recorded so cross-org switch tests can
    // assert the sync ran.
    $executeRaw: async () => {
      linkSyncs.push(1)
      return 1
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
      policyRules,
      policyBindings,
      linkSyncs,
    },
  }
}

const identityFor = (email: string, team?: ExternalAuthTeam, uoaSub?: string) => ({
  email,
  displayName: 'Test User',
  team,
  ...(uoaSub ? { uoaSub } : {}),
})

const team = (activeTeamId: string, role = 'member'): ExternalAuthTeam => ({
  activeOrgId: 'uoa-org-1',
  activeTeamId,
  teamIds: [activeTeamId],
  teamRoles: { [activeTeamId]: role },
})

test('auto-provisions the per-UOA-org Organization and its team', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const ctx = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-backend')))

  assert.ok(ctx)
  // The UOA organisation maps 1:1 to its OWN local Organization — never the
  // pre-existing (legacy shared) org.
  assert.notEqual(ctx!.organizationId, orgId)
  const org = state.orgs.find((o) => o.id === ctx!.organizationId)
  assert.equal(org?.externalOrgId, 'uoa-org-1')
  // Placeholder name until the team directory supplies UOA's orgName.
  assert.equal(org?.name, 'Organisation uoa-org-')
  const materializedTeam = state.teams.find((t) => t.id === ctx!.teamId)
  assert.equal(materializedTeam?.externalTeamId, 'ws-backend')
  assert.equal(materializedTeam?.externalOrgId, 'uoa-org-1')
  const project = state.projects.find((p) => p.id === ctx!.projectId)
  assert.equal(project?.organizationId, ctx!.organizationId)
  // UOA said `member` for this team, and a verified claim outranks the
  // first-materializer rule — the local row is a projection, not a local grant.
  assert.equal(state.teamMembers.find((m) => m.teamId === ctx!.teamId)?.role, 'member')
  // A #general channel is created and the user joins it.
  assert.equal(state.channels.length, 1)
  assert.equal(state.channelMembers.length, 1)
  // A brand-new Organization gets the default policy rules (deny-by-default
  // engine), scoped to exactly that org.
  assert.ok(state.policyRules.length > 0)
  assert.ok(state.policyRules.every((r) => r.organizationId === ctx!.organizationId))
})

test('two UOA organisations resolve to two distinct local Organizations', async () => {
  const { client, state } = makeFake({})
  const orgA: ExternalAuthTeam = {
    activeOrgId: 'uoa-org-a',
    activeTeamId: 'ws-a',
    teamIds: ['ws-a'],
    teamRoles: {},
  }
  const orgB: ExternalAuthTeam = {
    activeOrgId: 'uoa-org-b',
    activeTeamId: 'ws-b',
    teamIds: ['ws-b'],
    teamRoles: {},
  }

  const a = await resolveUoaTeamContext(client, identityFor('a@x.com', orgA, 'sub-1'))
  const b = await resolveUoaTeamContext(client, identityFor('a@x.com', orgB, 'sub-1'))

  assert.ok(a && b)
  assert.notEqual(a!.organizationId, b!.organizationId)
  assert.equal(state.orgs.find((o) => o.id === a!.organizationId)?.externalOrgId, 'uoa-org-a')
  assert.equal(state.orgs.find((o) => o.id === b!.organizationId)?.externalOrgId, 'uoa-org-b')
  // One person, one principal, memberships in BOTH organizations.
  assert.equal(a!.userId, b!.userId)
  assert.equal(state.orgMembers.filter((m) => m.userId === a!.userId).length, 2)
  // Each org got its own policy-rule scope.
  assert.ok(state.policyRules.some((r) => r.organizationId === a!.organizationId))
  assert.ok(state.policyRules.some((r) => r.organizationId === b!.organizationId))
  // A second login into org A reuses the same Organization row.
  const again = await resolveUoaTeamContext(client, identityFor('a@x.com', orgA, 'sub-1'))
  assert.equal(again!.organizationId, a!.organizationId)
  assert.equal(state.orgs.filter((o) => o.externalOrgId !== null).length, 2)
})

test('auto-provisions the sole UOA team when the chooser omits active', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const soleTeam: ExternalAuthTeam = {
    orgId: 'uoa-org-only',
    orgRole: 'owner',
    teamIds: ['ws-only'],
    teamRoles: { 'ws-only': 'owner' },
  }

  const ctx = await resolveUoaTeamContext(
    client,
    identityFor('a@x.com', soleTeam),
  )

  assert.ok(ctx)
  const team = state.teams.find((item) => item.id === ctx!.teamId)
  assert.equal(team?.externalTeamId, 'ws-only')
  assert.equal(team?.externalOrgId, 'uoa-org-only')
})

test('two different teams resolve to two different Nessie teams (isolated environments)', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const backend = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-backend')))
  const design = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-design')))

  assert.ok(backend && design)
  assert.notEqual(backend!.teamId, design!.teamId)
  assert.notEqual(backend!.projectId, design!.projectId)
  assert.equal(state.teams.length, 2)
})

test('the same team resolves to the same team for a second user (shared environment)', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const first = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-shared', 'owner')))
  const second = await resolveUoaTeamContext(client, identityFor('b@x.com', team('ws-shared', 'member')))

  assert.ok(first && second)
  assert.equal(first!.teamId, second!.teamId)
  assert.equal(state.teams.length, 1)
  // Both users are members of the one team team.
  assert.equal(state.teamMembers.filter((m) => m.teamId === first!.teamId).length, 2)
})

test('rejects an existing team bound to the same team id under another external org', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const first = await resolveUoaTeamContext(
    client,
    identityFor('owner@x.com', team('ws-shared', 'owner')),
  )
  assert.ok(first)
  const boundTeam = state.teams.find((team) => team.id === first.teamId)
  assert.ok(boundTeam)
  boundTeam.externalOrgId = 'different-uoa-org'
  const projectCount = state.projects.length

  await assert.rejects(
    resolveUoaTeamContext(
      client,
      identityFor('attacker@x.com', team('ws-shared')),
    ),
    /conflict with an existing team binding/,
  )
  assert.equal(state.projects.length, projectCount)
  assert.equal(state.users.some((user) => user.email === 'attacker@x.com'), false)
})

test('no team selection scopes to the shared org, never a UOA org (legacy behaviour)', async () => {
  const orgId = randomUUID()
  const { client, defaultTeamId } = makeFake({ organizationId: orgId, withDefaultTeam: true })

  // A UOA login materialises its per-org team; a later login with no
  // team claim at all (generic OIDC shape) stays in the legacy shared
  // org's default team — it cannot reach into a UOA organization it holds no
  // claim for.
  const first = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-only')))
  const again = await resolveUoaTeamContext(client, identityFor('a@x.com', undefined))

  assert.ok(first && again)
  assert.notEqual(first!.organizationId, orgId)
  assert.equal(again!.organizationId, orgId)
  assert.equal(again!.teamId, defaultTeamId)
})

test('a brand-new user with no team claim lands in the default team (non-UOA OIDC)', async () => {
  const orgId = randomUUID()
  const { client, defaultTeamId } = makeFake({ organizationId: orgId, withDefaultTeam: true })

  const ctx = await resolveUoaTeamContext(client, identityFor('new@x.com', undefined))

  assert.ok(ctx)
  assert.equal(ctx!.teamId, defaultTeamId)
})

test('an existing team maps the UOA team role to the Nessie member role', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  // Owner materialises the team; a later admin joins with role mapped admin.
  await resolveUoaTeamContext(client, identityFor('owner@x.com', team('ws-eng', 'owner')))
  const adminCtx = await resolveUoaTeamContext(client, identityFor('admin@x.com', team('ws-eng', 'admin')))

  assert.ok(adminCtx)
  const adminMembership = state.teamMembers.find(
    (m) => m.teamId === adminCtx!.teamId && m.userId === adminCtx!.userId,
  )
  assert.equal(adminMembership?.role, 'admin')
})

test('team switch materialization uses the authoritative target role and is idempotent', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const target = { organizationId: 'uoa-org-1', teamId: 'ws-target' }
  await resolveUoaTeamContext(
    client,
    identityFor('owner@x.com', team(target.teamId, 'owner')),
  )
  const source = await resolveUoaTeamContext(
    client,
    identityFor('switcher@x.com', team('ws-source', 'member'), 'uoa-user-switcher'),
  )
  assert.ok(source)

  const materialize = () => materializeUoaTeamSwitch(client, {
    identity: {
      displayName: 'Switching Admin',
      email: 'switcher@x.com',
      externalSubject: 'uoa-user-switcher',
      uoaTokenVersion: 4,
      team: team(target.teamId, 'admin'),
    },
    target,
    userId: source!.userId,
  })
  await materialize()
  await materialize()

  const targetTeam = state.teams.find(
    (team) => team.externalTeamId === target.teamId,
  )
  assert.ok(targetTeam)
  const memberships = state.teamMembers.filter(
    (member) => member.teamId === targetTeam.id && member.userId === source!.userId,
  )
  assert.equal(memberships.length, 1)
  assert.equal(memberships[0]?.role, 'admin')
})

test('a cross-org team switch materializes the TARGET organization and its links', async () => {
  const { client, state } = makeFake({})
  const source = await resolveUoaTeamContext(
    client,
    identityFor('mover@x.com', team('ws-source', 'member'), 'uoa-sub-mover'),
  )
  assert.ok(source)
  const target = { organizationId: 'uoa-org-2', teamId: 'ws-elsewhere' }
  const targetTeamClaim: ExternalAuthTeam = {
    activeOrgId: target.organizationId,
    activeTeamId: target.teamId,
    teamIds: [target.teamId],
    teamRoles: { [target.teamId]: 'member' },
  }
  const syncsBefore = state.linkSyncs.length

  await materializeUoaTeamSwitch(client, {
    identity: {
      displayName: 'Mover',
      email: 'mover@x.com',
      externalSubject: 'uoa-sub-mover',
      uoaTokenVersion: 4,
      team: targetTeamClaim,
    },
    target,
    userId: source!.userId,
  })

  // The switch landed in a brand-new per-UOA-org Organization…
  const targetOrg = state.orgs.find((o) => o.externalOrgId === 'uoa-org-2')
  assert.ok(targetOrg)
  assert.notEqual(targetOrg!.id, source!.organizationId)
  const targetTeam = state.teams.find((t) => t.externalTeamId === target.teamId)
  assert.ok(targetTeam)
  assert.equal(
    state.projects.find((p) => p.id === targetTeam!.projectId)?.organizationId,
    targetOrg!.id,
  )
  // …with the mover a member there…
  assert.ok(state.orgMembers.some(
    (m) => m.organizationId === targetOrg!.id && m.userId === source!.userId,
  ))
  // …and the TARGET org's first-party account links synced, so the rescope
  // binding advance (which requires the target-org `nessie` link) can commit.
  assert.ok(state.linkSyncs.length > syncsBefore)
})

test('a UOA login resolves the principal by subject even after an email change', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const first = await resolveUoaTeamContext(
    client,
    identityFor('old@x.com', team('ws-eng'), 'uoa-sub-stable'),
  )
  // UOA renamed the address; the stable subject still finds the same person.
  const second = await resolveUoaTeamContext(
    client,
    identityFor('renamed@x.com', team('ws-eng'), 'uoa-sub-stable'),
  )

  assert.ok(first && second)
  assert.equal(second!.userId, first!.userId)
  assert.equal(state.users.length, 1)
})

test('a UOA login adopts a pre-subject email row exactly once', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  // A row created before subject keying (or by a generic OIDC login).
  const legacy = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-eng')))
  assert.ok(legacy)
  assert.equal(state.users[0]?.uoaSub, null)

  const adopted = await resolveUoaTeamContext(
    client,
    identityFor('a@x.com', team('ws-eng'), 'uoa-sub-adopted'),
  )

  assert.ok(adopted)
  assert.equal(adopted!.userId, legacy!.userId)
  assert.equal(state.users.length, 1)
  assert.equal(state.users[0]?.uoaSub, 'uoa-sub-adopted')
})

test('a UOA login for an email bound to a different subject fails closed', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })

  const bound = await resolveUoaTeamContext(
    client,
    identityFor('a@x.com', team('ws-eng'), 'uoa-sub-original'),
  )
  assert.ok(bound)
  const membershipCount = state.teamMembers.length

  await assert.rejects(
    resolveUoaTeamContext(
      client,
      identityFor('a@x.com', team('ws-eng'), 'uoa-sub-impostor'),
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

  const uoaCtx = await resolveUoaTeamContext(
    client,
    identityFor('a@x.com', team('ws-eng'), 'uoa-sub-1'),
  )
  // A generic OIDC login for the same address still resolves by email
  // (unchanged behaviour) and does not touch the stored subject.
  const genericCtx = await resolveUoaTeamContext(client, identityFor('a@x.com', undefined))

  assert.ok(uoaCtx && genericCtx)
  assert.equal(genericCtx!.userId, uoaCtx!.userId)
  assert.equal(state.users[0]?.uoaSub, 'uoa-sub-1')

  const fresh = await resolveUoaTeamContext(client, identityFor('fresh@x.com', undefined))
  assert.ok(fresh)
  assert.equal(state.users.find((u) => u.email === 'fresh@x.com')?.uoaSub, null)
})

test('team switch materialization refuses a user bound to a different subject', async () => {
  const orgId = randomUUID()
  const { client } = makeFake({ organizationId: orgId })
  const source = await resolveUoaTeamContext(
    client,
    identityFor('switcher@x.com', team('ws-source', 'member'), 'uoa-sub-real'),
  )
  assert.ok(source)

  await assert.rejects(
    materializeUoaTeamSwitch(client, {
      identity: {
        displayName: 'Switching Admin',
        email: 'switcher@x.com',
        externalSubject: 'uoa-sub-other',
        uoaTokenVersion: 4,
        team: team('ws-target', 'admin'),
      },
      target: { organizationId: 'uoa-org-1', teamId: 'ws-target' },
      userId: source!.userId,
    }),
    /no longer matches this UnlikeOtherAI session/,
  )
})

// --- UOA is the authority for org/team roles (gap analysis, phase 4) ---------

test('the first materializer still owns a team UOA sent no role for', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const roleless: ExternalAuthTeam = {
    activeOrgId: 'uoa-org-1',
    activeTeamId: 'ws-silent',
    teamIds: ['ws-silent'],
    teamRoles: {},
  }

  const ctx = await resolveUoaTeamContext(client, identityFor('a@x.com', roleless))

  assert.ok(ctx)
  assert.equal(state.teamMembers.find((m) => m.teamId === ctx!.teamId)?.role, 'owner')
})

test('the org_role claim decides the org membership at first login', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const asAdmin: ExternalAuthTeam = {
    ...team('ws-eng', 'member'),
    orgRole: 'admin',
  }

  const ctx = await resolveUoaTeamContext(client, identityFor('a@x.com', asAdmin))

  assert.ok(ctx)
  assert.equal(ctx!.orgRole, 'admin')
  assert.equal(
    state.orgMembers.find((m) => m.userId === ctx!.userId)?.role,
    'admin',
  )
})

test('with no org_role claim the FIRST materializer of a brand-new org owns it', async () => {
  const { client, state } = makeFake({})

  const ctx = await resolveUoaTeamContext(client, identityFor('a@x.com', team('ws-eng')))

  assert.ok(ctx)
  // Mirror of the first-materializer team rule: somebody must be able to
  // administer the organization that was just created, and UOA sent no claim.
  assert.equal(ctx!.orgRole, 'owner')
  assert.equal(state.orgMembers.find((m) => m.userId === ctx!.userId)?.role, 'owner')
})

test('with no org_role claim a LATER joiner of an existing org defaults to member', async () => {
  const { client, state } = makeFake({})

  await resolveUoaTeamContext(client, identityFor('first@x.com', team('ws-eng')))
  const ctx = await resolveUoaTeamContext(client, identityFor('later@x.com', team('ws-eng')))

  assert.ok(ctx)
  assert.equal(ctx!.orgRole, 'member')
  assert.equal(state.orgMembers.find((m) => m.userId === ctx!.userId)?.role, 'member')
})

test('a verified org_role claim outranks the first-org-materializer rule', async () => {
  const { client, state } = makeFake({})
  const asMember: ExternalAuthTeam = {
    ...team('ws-eng', 'member'),
    orgRole: 'member',
  }

  const ctx = await resolveUoaTeamContext(client, identityFor('a@x.com', asMember))

  assert.ok(ctx)
  // First into a brand-new org, but UOA SAID member — the claim is complete.
  assert.equal(ctx!.orgRole, 'member')
  assert.equal(state.orgMembers.find((m) => m.userId === ctx!.userId)?.role, 'member')
})

test('a UOA promotion propagates at the next login', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const login = (orgRole: string, teamRole: string) =>
    resolveUoaTeamContext(client, identityFor('a@x.com', {
      ...team('ws-eng', teamRole),
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
    resolveUoaTeamContext(client, identityFor(email, {
      ...team('ws-eng', teamRole),
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

test('a UOA demotion of the LAST owner of a per-UOA-org Organization applies', async () => {
  const { client, state } = makeFake({})
  const login = (orgRole: string) =>
    resolveUoaTeamContext(client, identityFor('solo@x.com', {
      ...team('ws-eng', 'owner'),
      orgRole,
    }, 'uoa-sub-solo'))

  const first = await login('owner')
  // Organizations map 1:1 to UOA organisations, so the verified org_role claim
  // is a COMPLETE statement about this org's membership: the old shared-org
  // last-owner floor no longer applies — UOA demoting its only owner wins.
  const second = await login('member')

  assert.ok(first && second)
  assert.equal(second!.orgRole, 'member')
  assert.equal(state.orgMembers.find((m) => m.userId === second!.userId)?.role, 'member')
})

test('the last-owner floor survives only for a null-externalOrgId (legacy shared) org', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId })
  const userId = randomUUID()
  state.orgMembers.push({ organizationId: orgId, userId, role: 'owner' })
  const scaffold = { projectId: randomUUID(), teamId: randomUUID() }

  const projected = await projectUoaRoles(
    client as unknown as Parameters<typeof projectUoaRoles>[0],
    {
      claims: { orgRole: 'member', teamRole: null },
      organizationId: orgId,
      projectId: scaffold.projectId,
      teamId: scaffold.teamId,
      userId,
    },
  )

  // The seeded org carries no external org id — a per-UOA-org claim is not a
  // complete statement about who administers it, so its last active owner is
  // never demoted by the projection.
  assert.equal(projected.orgRole, 'owner')
  assert.equal(state.orgMembers.find((m) => m.userId === userId)?.role, 'owner')
})

test('a login with no UOA claims leaves an existing role untouched', async () => {
  const orgId = randomUUID()
  const { client, state } = makeFake({ organizationId: orgId, withDefaultTeam: true })

  const first = await resolveUoaTeamContext(
    client,
    identityFor('a@x.com', { ...team('ws-eng', 'admin'), orgRole: 'admin' }, 'uoa-sub-1'),
  )
  assert.ok(first)
  // A generic (non-UOA) OIDC login: no team claim at all. It scopes to
  // the legacy shared org and projects nothing — the UOA org's rows stay put.
  const again = await resolveUoaTeamContext(client, identityFor('a@x.com', undefined))

  assert.ok(again)
  assert.equal(again!.organizationId, orgId)
  assert.equal(
    state.orgMembers.find(
      (m) => m.userId === first!.userId && m.organizationId === first!.organizationId,
    )?.role,
    'admin',
  )
  assert.equal(
    state.teamMembers.find((m) => m.teamId === first!.teamId)?.role,
    'admin',
  )
})
