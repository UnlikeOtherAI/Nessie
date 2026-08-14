import { randomUUID } from 'node:crypto'

import type { Spy } from './auth-login-workspace-target-fixture.js'

/**
 * In-memory Prisma fake covering exactly the queries the workspace-switch
 * recovery login route and its services perform. Every operation appends
 * `model.method` to `spy.calls` — `user.findUnique` distinguishes `:id` from
 * `:email` — so tests can prove the recovery path never looks up, creates, or
 * remaps a principal by email.
 */

type Row = Record<string, unknown>

export type FakeInput = {
  users?: Row[]
  organizationId?: string
  teamRows?: Row[]
  projectRows?: Row[]
  channelRows?: Row[]
  organizationMembers?: Row[]
  teamMembers?: Row[]
  projectMembers?: Row[]
  channelMembers?: Row[]
}

export type SeedInput = FakeInput & { organizationId: string }

export const makePrisma = (spy: Spy, input: SeedInput) => {
  const users = [...(input.users ?? [])]
  const orgs = [{ id: input.organizationId }]
  const teams = [...(input.teamRows ?? [])]
  const projects = [...(input.projectRows ?? [])]
  const channels = [...(input.channelRows ?? [])]
  const organizationMembers = [...(input.organizationMembers ?? [])]
  const teamMembers = [...(input.teamMembers ?? [])]
  const projectMembers = [...(input.projectMembers ?? [])]
  const channelMembers = [...(input.channelMembers ?? [])]

  // Included-relation lookups for the membership findMany below. Production
  // `loadUserMemberships` (services/auth.ts) reads `organization.name`,
  // `project.organizationId`, and `team.projectId`, so the fake must project
  // those objects from the seeded orgs/projects/teams rather than returning
  // bare flat membership rows. Orgs/projects/teams seeded without a name get
  // a stable synthesized one.
  const orgRecord = (orgId: unknown, index: number): Row => {
    const org = orgs.find((candidate) => candidate.id === orgId) ?? { id: orgId }
    return { name: `Organization ${index + 1}`, ...org }
  }
  const projectRecord = (projectId: unknown, index: number): Row | undefined => {
    const project = projects.find((candidate) => candidate.id === projectId)
    return project
      ? { name: `Project ${index + 1}`, ...project }
      : undefined
  }
  const teamRecord = (teamId: unknown): Row | undefined =>
    teams.find((team) => team.id === teamId)

  const record = (key: string): void => {
    spy.calls.push(key)
  }

  const findUser = (where: Row): Row | null =>
    users.find((user) =>
      (where.id !== undefined && user.id === where.id)
      || (where.email !== undefined && user.email === where.email)) ?? null

  // sessionUserInclude (services/users.ts): memberships plus statuses, so
  // loadSessionUserById/buildSessionForUser hydrate from the same rows.
  const userInclude = (user: Row): Row => ({
    avatarUrl: null,
    avatarAttachmentId: null,
    preferences: null,
    pronouns: null,
    superAdmin: false,
    ...user,
    organizationMembers: organizationMembers.filter((m) => m.userId === user.id),
    projectMembers: projectMembers.filter((m) => m.userId === user.id),
    teamMembers: teamMembers.filter((m) => m.userId === user.id),
    statuses: [],
  })

  const membershipRows = (model: string): Row[] =>
    model === 'organizationMember' ? organizationMembers
    : model === 'projectMember' ? projectMembers
    : model === 'teamMember' ? teamMembers
    : channelMembers

  const scopeField = (key: Row): string =>
    key.organizationId !== undefined ? 'organizationId'
    : key.projectId !== undefined ? 'projectId'
    : key.teamId !== undefined ? 'teamId'
    : 'channelId'

  const findMembership = (model: string, where: Row): Row | null => {
    const key = Object.values(where)[0] as Row
    const field = scopeField(key)
    return membershipRows(model).find((m) => m[field] === key[field] && m.userId === key.userId)
      ?? null
  }

  const genericModel = (name: string, rows: Row[]): Record<string, unknown> => ({
    findFirst: async () => (record(`${name}.findFirst`), rows[0] ?? null),
    findMany: async ({ where }: { where?: Row } = {}) => (
      record(`${name}.findMany`),
      rows.filter((row) => where?.userId === undefined || row.userId === where.userId)
    ),
    upsert: async ({ where, create }: { where: Row; create: Row }) => {
      record(`${name}.upsert`)
      const existing = findMembership(name, where)
      if (existing) return existing
      rows.push(create)
      return create
    },
  })

  const prisma = {
    $queryRaw: async () => [{ count: 0, slug: 'nessie' }],
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    organization: {
      findFirst: async () => (record('organization.findFirst'), orgs[0] ?? null),
    },
    user: {
      count: async () => (record('user.count'), users.length),
      create: async () => {
        record('user.create')
        throw new Error('user.create must never run for recovery')
      },
      update: async () => {
        record('user.update')
        throw new Error('user.update must never run for recovery')
      },
      findUnique: async ({ where }: { where: Row }) => {
        const byId = where.id !== undefined
        record(byId ? 'user.findUnique:id' : 'user.findUnique:email')
        const found = findUser(where)
        return found ? userInclude(found) : null
      },
    },
    organizationMember: {
      ...genericModel('organizationMember', organizationMembers),
      findMany: async ({ where }: { where?: Row } = {}) => (
        record('organizationMember.findMany'),
        organizationMembers
          .filter((row) => where?.userId === undefined || row.userId === where.userId)
          .map((row, index) => ({
            ...row,
            organization: orgRecord(row.organizationId, index),
          }))
      ),
      findUnique: async ({ where }: { where: Row }) => (
        record('organizationMember.findUnique'),
        findMembership('organizationMember', where)
      ),
    },
    projectMember: {
      ...genericModel('projectMember', projectMembers),
      findMany: async ({ where }: { where?: Row } = {}) => (
        record('projectMember.findMany'),
        projectMembers
          .filter((row) => where?.userId === undefined || row.userId === where.userId)
          .map((row, index) => ({ ...row, project: projectRecord(row.projectId, index) }))
      ),
    },
    teamMember: {
      ...genericModel('teamMember', teamMembers),
      findMany: async ({ where }: { where?: Row } = {}) => (
        record('teamMember.findMany'),
        teamMembers
          .filter((row) => where?.userId === undefined || row.userId === where.userId)
          .map((row) => ({ ...row, team: teamRecord(row.teamId) }))
      ),
    },
    channelMember: {
      ...genericModel('channelMember', channelMembers),
      deleteMany: async () => (record('channelMember.deleteMany'), { count: 0 }),
    },
    project: {
      create: async ({ data }: { data: Row }) => {
        record('project.create')
        const row = { id: randomUUID(), name: 'Project', ...data }
        projects.push(row)
        return row
      },
    },
    boardColumn: { createMany: async () => (record('boardColumn.createMany'), { count: 0 }) },
    team: {
      create: async ({ data }: { data: Row }) => {
        record('team.create')
        const row = { id: randomUUID(), name: 'Team', ...data }
        teams.push(row)
        return row
      },
      findFirst: async ({ where, select }: { where?: Row; select?: Row }) => {
        record('team.findFirst')
        const projectRow = (team: Row) =>
          projects.find((p) => p.id === team.projectId)
            ?? (where?.project?.organizationId !== undefined
              ? { id: team.projectId ?? randomUUID(), organizationId: where.project.organizationId }
              : null)
        const found = teams.find((team) =>
          (where?.externalWorkspaceId === undefined
            || team.externalWorkspaceId === where.externalWorkspaceId)
          && (where?.name === undefined || team.name === where.name)
          && (where?.id === undefined || team.id === where.id)
          && (where?.project?.organizationId === undefined
            || projectRow(team)?.organizationId === where.project.organizationId)
          && (where?.systemManaged === undefined || team.systemManaged === where.systemManaged))
        if (!found) return null
        if (select?.project) {
          return { ...found, project: projectRow(found) }
        }
        return found
      },
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        record('team.findUnique')
        const found = teams.find((team) =>
          (where.id !== undefined && team.id === where.id)
          || (where.externalWorkspaceId !== undefined
            && team.externalWorkspaceId === where.externalWorkspaceId))
        if (!found) return null
        if (select?.project) {
          return { ...found, project: projects.find((p) => p.id === found.projectId) }
        }
        return found
      },
      findMany: async () => (record('team.findMany'), teams),
    },
    channel: {
      create: async ({ data }: { data: Row }) => {
        record('channel.create')
        const row = { id: randomUUID(), ...data }
        channels.push(row)
        return row
      },
      findFirst: async ({ where }: { where?: Row }) => {
        record('channel.findFirst')
        return channels.find((channel) =>
          (where?.teamId === undefined || channel.teamId === where.teamId)
          && (where?.visibility === undefined || channel.visibility === where.visibility)) ?? null
      },
      upsert: async ({ where, create }: { where: Row; create: Row }) => {
        record('channel.upsert')
        const existing = channels.find((channel) => channel.dmKey === where.dmKey)
        if (existing) return existing
        const row = { id: randomUUID(), ...create }
        channels.push(row)
        return row
      },
    },
    agent: {
      findFirst: async () => (record('agent.findFirst'), null),
      // The PA bootstrap legitimately creates the org's assistant agent on a
      // successful login — it is workspace plumbing, not an identity write.
      create: async ({ data, select }: { data: Row; select?: Row }) => (
        record('agent.create'),
        select ? { id: randomUUID() } : { id: randomUUID(), ...data }
      ),
      findUniqueOrThrow: async () => (
        record('agent.findUniqueOrThrow'),
        { id: randomUUID(), toolPolicy: null }
      ),
      update: async () => (record('agent.update'), { id: randomUUID() }),
    },
    thread: {
      create: async ({ data }: { data: Row }) => (
        record('thread.create'),
        { id: randomUUID(), ...data }
      ),
      findFirst: async () => (record('thread.findFirst'), null),
      upsert: async ({ create }: { create: Row }) => (
        record('thread.upsert'),
        { id: randomUUID(), ...create }
      ),
    },
    agentBinding: {
      upsert: async () => (record('agentBinding.upsert'), { id: randomUUID() }),
    },
    productAccountLink: {
      findUnique: async () => (record('productAccountLink.findUnique'), null),
    },
    pushRegistrationGeneration: {
      upsert: async () => (record('pushRegistrationGeneration.upsert'), { value: 1n }),
    },
    attachment: { findMany: async () => (record('attachment.findMany'), []) },
  }

  return prisma
}
