import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

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

const mailboxPrisma = (options: { access?: boolean; role?: string; teamMember?: boolean } = {}) =>
  ({
    mailboxConnection: {
      findMany: async () => options.access === false ? [] : [sharedConnection],
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: options.role ?? 'member' }),
    },
    teamMember: {
      findUnique: async () => options.teamMember === false ? null : { id: 'membership' },
    },
  }) as unknown as PrismaClient

test('mail presentation refuses a shared mailbox without a live team entitlement', async () => {
  await assert.rejects(
    resolveConnectedMailPresentationAccess(mailboxPrisma({ teamMember: false }), {
      accountId: IDS.account,
      agentId: IDS.agent,
      effectiveUserId: IDS.user,
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
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    /not been given access|not one I can use/,
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
      organizationId: IDS.organization,
      source: 'mailbox',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
})

test('mail presentation proves that the current user owns the Google connection', async () => {
  const prisma = {
    commsConnection: {
      findFirst: async () => ({ id: IDS.account, ownerUserId: IDS.user }),
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
  } as unknown as PrismaClient
  const access = await resolveConnectedMailPresentationAccess(prisma, {
    accountId: IDS.account,
    agentId: IDS.agent,
    effectiveUserId: IDS.user,
    organizationId: IDS.organization,
    source: 'gmail',
  })
  assert.deepEqual(access.basis, { scopeId: IDS.user, scopeType: 'user' })
})

test('mail presentation binds a Gmail compose doorway to the current owner draft', async () => {
  const calls: unknown[] = []
  const prisma = {
    commsConnection: { findFirst: async () => ({ id: IDS.account, ownerUserId: IDS.user }) },
    gmailDraftAction: { findFirst: async (args: unknown) => { calls.push(args); return null } },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
  } as unknown as PrismaClient
  await assert.rejects(
    resolveConnectedMailPresentationAccess(prisma, {
      accountId: IDS.account,
      agentId: IDS.agent,
      draftId: '00000000-0000-4000-8000-000000000006',
      effectiveUserId: IDS.user,
      organizationId: IDS.organization,
      source: 'gmail',
    }),
    (error: unknown) => error instanceof ConnectedMailPresentationError,
  )
  assert.match(JSON.stringify(calls[0]), new RegExp(`"connectionId":"${IDS.account}"`))
  assert.match(JSON.stringify(calls[0]), new RegExp(`"ownerUserId":"${IDS.user}"`))
})
