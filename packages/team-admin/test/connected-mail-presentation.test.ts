import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { getGoogleCapability } from '@nessie/schemas'

import {
  ConnectedMailPresentationError,
  resolveConnectedMailPresentationAccess,
} from '../src/connected-mail-presentation.js'

const IDS = {
  account: 'a1',
  agent: 'a2',
  organization: 'a3',
  team: 'a4',
  user: 'a5',
}

const sharedConnection = {
  id: IDS.account,
  label: 'Support',
  ownerUserId: null,
  teamId: IDS.team,
}

const gmailConnection = (capability: 'gmail.read' | 'gmail.compose') => ({
  disabledCapabilities: [],
  grantedScopes: [...getGoogleCapability(capability).scopes],
  id: IDS.account,
  ownerUserId: IDS.user,
})

const mailboxPrisma = (options: {
  access?: boolean
  connections?: typeof sharedConnection[]
  role?: string
  teamMember?: boolean
  visibleTeamIds?: string[]
} = {}) =>
  ({
    mailboxConnection: {
      findMany: async () => options.access === false ? [] : options.connections ?? [sharedConnection],
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: options.role ?? 'member' }),
    },
    teamMember: {
      findUnique: async (args: { where: { teamId_userId: { teamId: string } } }) =>
        options.teamMember === false || (options.visibleTeamIds
          && !options.visibleTeamIds.includes(args.where.teamId_userId.teamId))
          ? null
          : { id: 'membership' },
    },
  }) as unknown as PrismaClient

test('mail presentation refuses a shared mailbox without a live team entitlement', async () => {
  await assert.rejects(
    resolveConnectedMailPresentationAccess(mailboxPrisma({ teamMember: false }), {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'account',
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('mail presentation does not let an organization admin bypass live team membership', async () => {
  await assert.rejects(
    resolveConnectedMailPresentationAccess(mailboxPrisma({ role: 'admin', teamMember: false }), {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'account',
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('mail presentation still requires the per-connection access row', async () => {
  await assert.rejects(
    resolveConnectedMailPresentationAccess(mailboxPrisma({ access: false }), {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'account',
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('mail presentation ambiguity does not disclose inaccessible shared mailboxes', async () => {
  const visibleOne = { ...sharedConnection, id: 'visible-1', label: 'Support', teamId: 'team-1' }
  const visibleTwo = { ...sharedConnection, id: 'visible-2', label: 'Sales', teamId: 'team-2' }
  const hidden = { ...sharedConnection, id: 'secret-finance', label: 'Secret finance', teamId: 'team-3' }
  await assert.rejects(
    resolveConnectedMailPresentationAccess(mailboxPrisma({
      connections: [visibleOne, visibleTwo, hidden],
      visibleTeamIds: ['team-1', 'team-2'],
    }), {
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'account',
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Support \(visible-1\).*Sales \(visible-2\)/)
      assert.doesNotMatch(error.message, /Secret finance|secret-finance/)
      return true
    },
  )
})

test('mail presentation refuses a personal mailbox after its owner loses live membership', async () => {
  const prisma = {
    mailboxConnection: {
      findMany: async () => [{
        ...sharedConnection,
        ownerUserId: IDS.user,
        teamId: null,
      }],
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: new Date(), role: 'member' }),
    },
  } as unknown as PrismaClient
  await assert.rejects(
    resolveConnectedMailPresentationAccess(prisma, {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'account',
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('mail presentation proves that the current user owns the Google connection', async () => {
  const prisma = {
    commsConnection: {
      findFirst: async () => gmailConnection('gmail.read'),
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
  } as unknown as PrismaClient
  const access = await resolveConnectedMailPresentationAccess(prisma, {
    accountId: IDS.account,
    agentId: IDS.agent,
    effectiveUserId: IDS.user,
    mode: 'account',
    organizationId: IDS.organization,
    source: 'gmail',
  })
  assert.deepEqual(access.basis, { scopeId: IDS.user, scopeType: 'user' })
})

test('mail presentation binds a Gmail compose doorway to the current owner draft', async () => {
  const calls: unknown[] = []
  const prisma = {
    commsConnection: { findFirst: async () => gmailConnection('gmail.compose') },
    gmailDraftAction: { findFirst: async (args: unknown) => { calls.push(args); return null } },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
  } as unknown as PrismaClient
  await assert.rejects(
    resolveConnectedMailPresentationAccess(prisma, {
      accountId: IDS.account,
      agentId: IDS.agent,
      draftId: '00000000-0000-4000-8000-000000000006',
    effectiveUserId: IDS.user,
      mode: 'compose',
      organizationId: IDS.organization,
      source: 'gmail',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
  assert.match(JSON.stringify(calls[0]), new RegExp(`"connectionId":"${IDS.account}"`))
  assert.match(JSON.stringify(calls[0]), new RegExp(`"ownerUserId":"${IDS.user}"`))
})

test('a Gmail account or thread doorway requires the Gmail read capability', async () => {
  const prisma = {
    commsConnection: { findFirst: async () => gmailConnection('gmail.compose') },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
  } as unknown as PrismaClient
  await assert.rejects(
    resolveConnectedMailPresentationAccess(prisma, {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'thread',
      organizationId: IDS.organization,
      source: 'gmail',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('a Gmail compose doorway requires an enabled Gmail compose capability', async () => {
  const prisma = {
    commsConnection: {
      findFirst: async () => ({
        ...gmailConnection('gmail.compose'),
        disabledCapabilities: ['gmail.compose'],
      }),
    },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
  } as unknown as PrismaClient
  await assert.rejects(
    resolveConnectedMailPresentationAccess(prisma, {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
      mode: 'compose',
      organizationId: IDS.organization,
      source: 'gmail',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})
