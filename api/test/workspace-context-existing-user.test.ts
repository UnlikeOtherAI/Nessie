import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import type { ExternalAuthWorkspace } from '../src/services/identity-display.js'
import { UoaRecoveryAccountLinkError } from '../src/services/uoa-recovery-link.js'
import { resolveUoaWorkspaceContext } from '../src/services/workspace-context.js'

/**
 * Focused coverage for the account-bound recovery seam in
 * resolveUoaWorkspaceContext: `existingUserId` locks and reuses exactly that
 * local principal — never an email lookup, never a user create/update, never
 * a remap. The same UOA subject whose email changed keeps their existing
 * local id; a missing principal fails closed with zero membership writes.
 */

type Row = Record<string, unknown>

type FakeState = {
  calls: string[]
  channels: Row[]
  channelMembers: Row[]
  orgMembers: Row[]
  orgs: Row[]
  projectMembers: Row[]
  projects: Row[]
  teamMembers: Row[]
  teams: Row[]
  users: Row[]
}

const makeFake = (seed: {
  organizationId: string
  teams?: Row[]
  users?: Row[]
}): { client: PrismaClient; state: FakeState } => {
  const state: FakeState = {
    calls: [],
    channels: [],
    channelMembers: [],
    orgMembers: [],
    orgs: [{ id: seed.organizationId }],
    projectMembers: [],
    projects: [],
    teamMembers: [],
    teams: [...(seed.teams ?? [])],
    users: [...(seed.users ?? [])],
  }
  const record = (key: string): void => {
    state.calls.push(key)
  }
  const membershipUpsert = (rows: Row[], scopeField: string) =>
    async ({ where, create }: { where: Row; create: Row }) => {
      const key = Object.values(where)[0] as Row
      if (!rows.find((row) => row[scopeField] === key[scopeField] && row.userId === key.userId)) {
        rows.push(create)
      }
      return {}
    }
  const client = {
    $queryRaw: async () => (record('$queryRaw'), []),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    organization: {
      findFirst: async () => (record('organization.findFirst'), state.orgs[0] ?? null),
    },
    user: {
      count: async () => (record('user.count'), state.users.length),
      create: async () => {
        record('user.create')
        throw new Error('recovery must never create a user')
      },
      findUnique: async ({ where }: { where: Row }) => {
        const byId = where.id !== undefined
        record(byId ? 'user.findUnique:id' : 'user.findUnique:email')
        return state.users.find((user) =>
          (byId && user.id === where.id)
          || (!byId && user.email === where.email)) ?? null
      },
    },
    team: {
      findFirst: async () => (record('team.findFirst'), state.teams[0] ?? null),
      findUnique: async ({ where }: { where: Row }) => {
        record('team.findUnique')
        const found = state.teams.find((team) =>
          (where.id !== undefined && team.id === where.id)
          || (where.externalWorkspaceId !== undefined
            && team.externalWorkspaceId === where.externalWorkspaceId)) ?? null
        if (!found) return null
        return {
          ...found,
          project: state.projects.find((project) => project.id === found.projectId) ?? null,
        }
      },
      create: async ({ data }: { data: Row }) => {
        record('team.create')
        const row = { id: randomUUID(), ...data }
        state.teams.push(row)
        return row
      },
    },
    project: {
      create: async ({ data }: { data: Row }) => {
        record('project.create')
        const row = { id: randomUUID(), ...data }
        state.projects.push(row)
        return row
      },
    },
    boardColumn: { createMany: async () => (record('boardColumn.createMany'), { count: 0 }) },
    channel: {
      findFirst: async () => (record('channel.findFirst'), state.channels[0] ?? null),
      create: async ({ data }: { data: Row }) => {
        record('channel.create')
        const row = { id: randomUUID(), ...data }
        state.channels.push(row)
        return row
      },
    },
    organizationMember: {
      findUnique: async ({ where }: { where: Row }) => {
        record('organizationMember.findUnique')
        const key = where.organizationId_userId as Row
        const found = state.orgMembers.find((member) =>
          member.organizationId === key.organizationId && member.userId === key.userId)
        return found ? { role: found.role } : null
      },
      upsert: async (args: { where: Row; create: Row }) => {
        record('organizationMember.upsert')
        return membershipUpsert(state.orgMembers, 'organizationId')(args)
      },
    },
    projectMember: {
      upsert: async (args: { where: Row; create: Row }) => {
        record('projectMember.upsert')
        return membershipUpsert(state.projectMembers, 'projectId')(args)
      },
    },
    teamMember: {
      upsert: async (args: { where: Row; create: Row }) => {
        record('teamMember.upsert')
        return membershipUpsert(state.teamMembers, 'teamId')(args)
      },
      findFirst: async () => (record('teamMember.findFirst'), null),
    },
    channelMember: {
      upsert: async (args: { where: Row; create: Row }) => {
        record('channelMember.upsert')
        return membershipUpsert(state.channelMembers, 'channelId')(args)
      },
    },
  }
  return { client: client as unknown as PrismaClient, state }
}

const workspace = (activeTeamId: string): ExternalAuthWorkspace => ({
  activeOrgId: 'uoa-org-1',
  activeTeamId,
  teamIds: [activeTeamId],
  teamRoles: { [activeTeamId]: 'member' },
})

test('recovery reuses the exact existing principal without any email lookup', async () => {
  const orgId = randomUUID()
  const aliceId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const { client, state } = makeFake({
    organizationId: orgId,
    teams: [{
      id: teamId,
      externalOrgId: 'uoa-org-1',
      externalWorkspaceId: 'ws-target',
      projectId,
    }],
    users: [{
      id: aliceId,
      email: 'alice@example.com',
      displayName: 'Alice Example',
      avatarUrl: null,
    }],
  })
  state.projects.push({ id: projectId, organizationId: orgId })

  const context = await resolveUoaWorkspaceContext(client, {
    displayName: 'Alice Example',
    // UOA reports a CHANGED email for the same subject; recovery must not
    // touch it.
    email: 'alice-renamed@example.com',
    existingUserId: aliceId,
    expectedLocalOrganizationId: orgId,
    workspace: workspace('ws-target'),
  })

  assert.ok(context)
  assert.equal(context.userId, aliceId)
  assert.equal(context.organizationId, orgId)
  assert.equal(context.teamId, teamId)
  assert.equal(context.orgRole, 'member')
  // No email lookup, no user create/update anywhere in the recovery path.
  assert.equal(state.calls.includes('user.findUnique:email'), false)
  assert.equal(state.calls.includes('user.create'), false)
  // The user row was resolved by exact id, under the session lock ($queryRaw).
  assert.equal(state.calls.includes('user.findUnique:id'), true)
  assert.ok(state.calls.includes('$queryRaw'))
  // Memberships were materialized for exactly the existing principal.
  assert.equal(state.orgMembers.length, 1)
  assert.equal(state.orgMembers[0]?.userId, aliceId)
  assert.equal(state.teamMembers.length, 1)
  assert.equal(state.teamMembers[0]?.userId, aliceId)
})

test('recovery fails closed for a missing principal with zero membership writes', async () => {
  const orgId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const { client, state } = makeFake({
    organizationId: orgId,
    teams: [{
      id: teamId,
      externalOrgId: 'uoa-org-1',
      externalWorkspaceId: 'ws-target',
      projectId,
    }],
    users: [],
  })
  state.projects.push({ id: projectId, organizationId: orgId })

  const context = await resolveUoaWorkspaceContext(client, {
    displayName: 'Ghost User',
    email: 'ghost@example.com',
    existingUserId: randomUUID(),
    expectedLocalOrganizationId: orgId,
    workspace: workspace('ws-target'),
  })

  assert.equal(context, null)
  assert.equal(state.orgMembers.length, 0)
  assert.equal(state.teamMembers.length, 0)
  assert.equal(state.projectMembers.length, 0)
  assert.equal(state.calls.includes('user.findUnique:email'), false)
  assert.equal(state.calls.includes('user.create'), false)
})

test('recovery never bootstraps when the shared organization is missing', async () => {
  const { client, state } = makeFake({ organizationId: '' })
  state.orgs.length = 0

  const context = await resolveUoaWorkspaceContext(client, {
    displayName: 'Alice Example',
    email: 'alice@example.com',
    existingUserId: randomUUID(),
    expectedLocalOrganizationId: randomUUID(),
    workspace: workspace('ws-target'),
  })

  assert.equal(context, null)
  // No ambient organization probe at all: recovery's org comes only from the
  // bearer's claim, so a missing-organization database is never consulted.
  assert.equal(state.calls.includes('organization.findFirst'), false)
  assert.equal(state.calls.includes('user.findUnique:email'), false)
  assert.equal(state.calls.includes('user.create'), false)
  assert.equal(state.calls.includes('team.create'), false)
})

test('the conditional claim runs BEFORE the target existing-or-create branch', async () => {
  // The fence is the seam between the workspace advisory lock and any
  // target materialization: a refusing claim must abort before even the
  // bound-team probe runs, so a racy recovery leaves zero shared rows. The
  // claim fails with the REAL fence error contract — the same
  // UoaRecoveryAccountLinkError the route maps to a 401 identity refusal.
  const orgId = randomUUID()
  const aliceId = randomUUID()
  const { client, state } = makeFake({
    organizationId: orgId,
    users: [{
      id: aliceId,
      email: 'alice@example.com',
      displayName: 'Alice Example',
      avatarUrl: null,
    }],
  })

  const refusal = new UoaRecoveryAccountLinkError(
    'The Nessie account link changed while the recovery was completing.',
  )
  await assert.rejects(
    resolveUoaWorkspaceContext(client, {
      displayName: 'Alice Example',
      email: 'alice@example.com',
      existingUserId: aliceId,
      expectedLocalOrganizationId: orgId,
      recoveryLinkClaim: async () => {
        throw refusal
      },
      workspace: workspace('ws-target'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof UoaRecoveryAccountLinkError)
      assert.equal(error, refusal)
      assert.equal(
        (error as Error).message,
        'The Nessie account link changed while the recovery was completing.',
      )
      return true
    },
  )

  // The workspace advisory lock and the exact-principal read happened; the
  // target branch and every write model never ran.
  assert.equal(state.calls.includes('$queryRaw'), true)
  assert.equal(state.calls.includes('user.findUnique:id'), true)
  assert.equal(state.calls.includes('team.findUnique'), false)
  assert.equal(state.calls.includes('team.create'), false)
  assert.equal(state.calls.includes('project.create'), false)
  assert.equal(state.calls.includes('boardColumn.createMany'), false)
  assert.equal(state.calls.includes('channel.create'), false)
  assert.equal(state.orgMembers.length, 0)
  assert.equal(state.teamMembers.length, 0)
  assert.equal(state.projectMembers.length, 0)
  assert.equal(state.channelMembers.length, 0)
})

test('a refusing claim leaves no shared target rows behind for a NEW workspace', async () => {
  // Regression for the pre-refactor shape, where resolveWorkspaceTarget ran
  // in its own transaction BEFORE the principal fence: a refused claim would
  // have left the auto-provisioned project/team/channel committed. Now the
  // claim precedes that branch inside the one recovery transaction.
  const orgId = randomUUID()
  const aliceId = randomUUID()
  const { client, state } = makeFake({
    organizationId: orgId,
    users: [{
      id: aliceId,
      email: 'alice@example.com',
      displayName: 'Alice Example',
      avatarUrl: null,
    }],
  })

  await assert.rejects(
    resolveUoaWorkspaceContext(client, {
      displayName: 'Alice Example',
      email: 'alice@example.com',
      existingUserId: aliceId,
      expectedLocalOrganizationId: orgId,
      recoveryLinkClaim: async () => {
        throw new Error('claim refused')
      },
      workspace: workspace('ws-new'),
    }),
    /claim refused/,
  )
  assert.equal(state.projects.length, 0)
  assert.equal(state.teams.length, 0)
  assert.equal(state.channels.length, 0)
})

test('a mismatch between the claim org and the resolved org is impossible by construction', async () => {
  // There is no ambient org resolution on the recovery path: the context's
  // organizationId is exactly the bearer's claim, so the successful context
  // can never report a different org than the fence claimed under.
  const orgId = randomUUID()
  const aliceId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const { client, state } = makeFake({
    organizationId: orgId,
    teams: [{
      id: teamId,
      externalOrgId: 'uoa-org-1',
      externalWorkspaceId: 'ws-target',
      projectId,
    }],
    users: [{
      id: aliceId,
      email: 'alice@example.com',
      displayName: 'Alice Example',
      avatarUrl: null,
    }],
  })
  state.projects.push({ id: projectId, organizationId: orgId })
  let claimedOrg: string | null = null

  const context = await resolveUoaWorkspaceContext(client, {
    displayName: 'Alice Example',
    email: 'alice@example.com',
    existingUserId: aliceId,
    expectedLocalOrganizationId: orgId,
    recoveryLinkClaim: async () => {
      claimedOrg = orgId
    },
    workspace: workspace('ws-target'),
  })

  assert.ok(context)
  assert.equal(claimedOrg, orgId)
  assert.equal(context.organizationId, orgId)
  assert.equal(state.calls.includes('organization.findFirst'), false)
})
