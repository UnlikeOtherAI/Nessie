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
  activeSession?: boolean
  users?: Row[]
  organizationId?: string
  /**
   * The UOA organisation id mirrored by the seeded Organization
   * (`Organization.externalOrgId`, the 1:1 model). The fixture defaults it to
   * the exchange's ORG so recovery resolves the seeded org as its target.
   */
  organizationExternalOrgId?: string | null
  productAccountLinkRows?: Row[]
  /**
   * Race seam: fires once, at the START of the authoritative claim — after
   * the pre-billing proof (and billing) but before the claim's own read and
   * conditional update. A test mutating the seeded link rows here models an
   * interleaving renewal landing between the pre-billing proof and the
   * final claim. Subsequent claim-time reads do NOT re-fire it, so a test
   * tampering during the claim itself (under the row lock in production)
   * proves the conditional update still refuses.
   */
  onRecoveryLinkClaim?: (claimReads: number, rows: Row[]) => void
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
  const orgs: Row[] = [{
    id: input.organizationId,
    externalOrgId: input.organizationExternalOrgId ?? null,
  }]
  const teams = [...(input.teamRows ?? [])]
  const projects = [...(input.projectRows ?? [])]
  const channels = [...(input.channelRows ?? [])]
  const organizationMembers = [...(input.organizationMembers ?? [])]
  const teamMembers = [...(input.teamMembers ?? [])]
  const projectMembers = [...(input.projectMembers ?? [])]
  const channelMembers = [...(input.channelMembers ?? [])]
  const productAccountLinks = [...(input.productAccountLinkRows ?? [])]
  let claimFired = false
  let claimReads = 0

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
  // Session/user hydrations read memberships through the user include. Rows
  // seeded explicitly win; absent any, every seeded user is a member of the
  // fake's single org and every seeded project/team — a recovery principal is
  // provisioned into its target by definition of the shared workspace.
  const membershipsFor = (rows: Row[], scopeKey: string, user: Row): Row[] => {
    const seeded = rows.filter((m) => m.userId === user.id)
    if (seeded.length > 0) return seeded
    const scopeRows =
      scopeKey === 'organizationId' ? orgs
      : scopeKey === 'projectId' ? projects
      : teams
    return scopeRows.map((scope) => ({
      organizationId: orgs[0]?.id,
      projectId: scopeKey === 'projectId' ? scope.id : scope.projectId,
      teamId: scopeKey === 'teamId' ? scope.id : undefined,
      role: 'owner',
      userId: user.id,
    }))
  }
  const userInclude = (user: Row): Row => ({
    avatarUrl: null,
    avatarAttachmentId: null,
    preferences: null,
    pronouns: null,
    superAdmin: false,
    ...user,
    organizationMembers: membershipsFor(organizationMembers, 'organizationId', user),
    projectMembers: membershipsFor(projectMembers, 'projectId', user),
    teamMembers: membershipsFor(teamMembers, 'teamId', user),
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

  // services/integrations.ts syncUoaProductAccountLinks: one
  // INSERT ... ON CONFLICT per first-party product, refusing (count 0) when
  // the stored row carries a different subject or a NEWER epoch. The fake
  const prisma = {
    // Advisory locks and the workspace/org bootstrap probes.
    $queryRaw: async () => [{ count: 0, slug: 'nessie' }],
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    organization: {
      findFirst: async () => (record('organization.findFirst'), orgs[0] ?? null),
      findUnique: async ({ where }: { where: Row }) => {
        record('organization.findUnique')
        return orgs.find((org) =>
          (where.id !== undefined && org.id === where.id)
          || (where.externalOrgId !== undefined
            && org.externalOrgId === where.externalOrgId)) ?? null
      },
      create: async ({ data }: { data: Row }) => {
        record('organization.create')
        const row = { id: randomUUID(), ...data }
        orgs.push(row)
        return { id: row.id }
      },
    },
    policyRule: {
      count: async () => (record('policyRule.count'), 0),
      findFirst: async () => (record('policyRule.findFirst'), null),
      create: async ({ data }: { data: Row }) => {
        record('policyRule.create')
        const bindings = (data.bindings as
          | { create: Row[] }
          | undefined)?.create ?? []
        return {
          id: randomUUID(),
          ...data,
          conditions: data.conditions ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          bindings: bindings.map((b) => ({ id: randomUUID(), ...b })),
        }
      },
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
    refreshToken: {
      findFirst: async () => (
        record('refreshToken.findFirst'),
        input.activeSession === false ? null : { id: randomUUID() }
      ),
    },
    organizationMember: {
      ...genericModel('organizationMember', organizationMembers),
      findFirst: async () => (record('organizationMember.findFirst'), null),
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
      upsert: async ({ where, create }: { where: Row; create: Row }) => {
        record('organizationMember.upsert')
        const existing = findMembership('organizationMember', where)
        if (existing) return existing
        // Mirror the readOrgRole `role` select that follows the upserts.
        const row = { ...create, role: create.role ?? 'member' }
        organizationMembers.push(row)
        return row
      },
      count: async ({ where }: { where: Row }) => (
        record('organizationMember.count'),
        organizationMembers.filter((m) => m.organizationId === where.organizationId).length
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
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        record('productAccountLink.findUnique')
        const key = where.organizationId_userId_productSlug as Row | undefined
        const found = productAccountLinks.find((link) =>
          key !== undefined
          && link.organizationId === key.organizationId
          && link.userId === key.userId
          && link.productSlug === key.productSlug) ?? null
        // The claim's own pre-read selects ONLY `metadata`; the pre-billing
        // proof selects status/uoaSub/uoaTokenVersion. The race seam fires at
        // the START of the claim — after the pre-billing proof (and billing)
        // but before the claim's read + conditional update — so a mutation
        // lands exactly between preflight and the final claim. It never
        // re-fires during the claim itself.
        if (!claimFired && select?.metadata !== undefined) {
          claimFired = true
          claimReads += 1
          input.onRecoveryLinkClaim?.(claimReads, productAccountLinks)
        }
        // Honor the select projection like Prisma does: the fence reads
        // status/uoaSub/uoaTokenVersion and the claim reads metadata only.
        if (found && select) {
          const projected: Row = {}
          for (const field of Object.keys(select)) {
            if (select[field]) projected[field] = found[field]
          }
          return projected
        }
        return found
      },
      create: async ({ data }: { data: Row }) => {
        record('productAccountLink.create')
        productAccountLinks.push({ ...data })
        return { ...data }
      },
      // Kept alongside the seeded rows so tests can model the race honestly:
      // advance (or null) the exact stored link BEHIND the pre-billing read
      // and prove the conditional claim then refuses.
      __rows: productAccountLinks,
      // uoa-recovery-link.ts claimUoaRecoveryAccountLink: the conditional row
      // claim inside the resolver transaction. The fake applies the same
      // WHERE preconditions Prisma would (org + user + slug + linked + same
      // subject + a NON-NULL epoch within the [gte, lte] bound — a null
      // stored epoch never matches) so a test can advance or null the row
      // behind the pre-billing check and prove the claim refuses — a blind
      // `{ count: 1 }` would test nothing.
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        record('productAccountLink.updateMany')
        const epoch = where.uoaTokenVersion as
          | { gte?: number; lte?: number; not?: unknown }
          | undefined
        const matches = productAccountLinks.filter((link) =>
          link.organizationId === where.organizationId
          && link.userId === where.userId
          && link.productSlug === where.productSlug
          && link.status === where.status
          && link.uoaSub === where.uoaSub
          && link.uoaTokenVersion !== null
          && (epoch?.gte === undefined
            || (link.uoaTokenVersion as number) >= epoch.gte)
          && (epoch?.lte === undefined
            || (link.uoaTokenVersion as number) <= epoch.lte))
        for (const link of matches) {
          Object.assign(link, data)
        }
        return { count: matches.length }
      },
    },
    pushRegistrationGeneration: {
      upsert: async () => (record('pushRegistrationGeneration.upsert'), { value: 1n }),
    },
    attachment: { findMany: async () => (record('attachment.findMany'), []) },
  }

  return prisma
}
