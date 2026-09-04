import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerMailboxConnectionRoutes } from '../src/routes/mailbox-connections.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444'

const actorContext = (role: 'admin' | 'member' | 'owner' = 'owner'): AuthorizedActionContext => ({
  actor: { actorId: USER_ID, actorType: 'user', roles: [role] },
  actionContext: { requestId: 'mailbox-discovery-route-test' },
  tenant: { organizationId: ORGANIZATION_ID },
})

const makeApp = (input: {
  comms?: boolean
  own?: boolean
  role?: 'admin' | 'member' | 'owner'
  shared?: boolean
}) => {
  const seen = { mailboxWhere: [] as unknown[], commsWhere: [] as unknown[] }
  const prisma = {
    commsConnection: {
      findFirst: async (args: { where: { ownerUserId: string } }) => {
        seen.commsWhere.push(args.where)
        return input.comms && args.where.ownerUserId === USER_ID ? { id: CONNECTION_ID } : null
      },
    },
    mailboxConnection: {
      findFirst: async (args: { where: { ownerUserId?: string; teamId?: string } }) => {
        seen.mailboxWhere.push(args.where)
        if (input.own && args.where.ownerUserId === USER_ID) return { id: CONNECTION_ID }
        if (input.shared && args.where.teamId === TEAM_ID) return { id: CONNECTION_ID }
        return null
      },
    },
  } as unknown as PrismaClient
  const app = Fastify()
  registerMailboxConnectionRoutes(app, {
    authSecret: 'test-secret',
    prisma,
    requireActorContext: () => actorContext(input.role),
  } as never)
  return { app, seen }
}

test('authenticated discovery returns a native provider result without probing a password', async () => {
  const { app } = makeApp({})
  await app.ready()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mailbox-connections/discover',
      payload: { email: 'person@gmail.com' },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().data.provider, 'google')
    assert.equal(response.json().data.authentication.strategy, 'oauth2')
  } finally {
    await app.close()
  }
})

test('discovery maps malformed addresses to a field-level 400', async () => {
  const { app } = makeApp({})
  await app.ready()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mailbox-connections/discover',
      payload: { email: 'not-an-address' },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error.code, 'INVALID_EMAIL_ADDRESS')
    assert.equal(response.json().error.field, 'email')
  } finally {
    await app.close()
  }
})

test('discovery returns only the caller-owned personal or native duplicate hint', async () => {
  const own = makeApp({ own: true })
  await own.app.ready()
  try {
    const response = await own.app.inject({
      method: 'POST', url: '/api/mailbox-connections/discover', payload: { email: 'person@gmail.com' },
    })
    assert.deepEqual(response.json().data.existingConnection, {
      id: CONNECTION_ID, kind: 'mailbox_connection', scope: 'user',
    })
  } finally {
    await own.app.close()
  }

  const native = makeApp({ comms: true })
  await native.app.ready()
  try {
    const response = await native.app.inject({
      method: 'POST', url: '/api/mailbox-connections/discover', payload: { email: 'person@gmail.com' },
    })
    assert.deepEqual(response.json().data.existingConnection, {
      id: CONNECTION_ID, kind: 'comms_connection',
    })
  } finally {
    await native.app.close()
  }
})

test('a manager sees a duplicate only in the explicitly selected shared-team target', async () => {
  const { app } = makeApp({ shared: true, role: 'admin' })
  await app.ready()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mailbox-connections/discover',
      payload: { email: 'person@fastmail.com', scope: 'team', teamId: TEAM_ID },
    })
    assert.deepEqual(response.json().data.existingConnection, {
      id: CONNECTION_ID, kind: 'mailbox_connection', scope: 'team',
    })
  } finally {
    await app.close()
  }
})

test('a member receives no cross-user or cross-team duplicate existence hint', async () => {
  const { app, seen } = makeApp({ role: 'member', shared: true })
  await app.ready()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mailbox-connections/discover',
      payload: { email: 'person@gmail.com', scope: 'team', teamId: TEAM_ID },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().data.existingConnection, undefined)
    // The fake holds a shared row but it is never queried for a non-manager.
    // Native rows use the same owner predicate, so another user's Google row
    // likewise cannot produce this hint.
    assert.equal(seen.mailboxWhere.some((where) => 'teamId' in (where as object)), false)
  } finally {
    await app.close()
  }
})

test('reconnect refuses client attempts to retarget an existing connection', async () => {
  const { app } = makeApp({})
  await app.ready()
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/mailbox-connections/${CONNECTION_ID}/reconnect`,
      payload: {
        address: 'someone-else@example.com',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecurity: 'tls',
        password: 'replacement-secret',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        username: 'original@example.com',
      },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error.code, 'VALIDATION_ERROR')
  } finally {
    await app.close()
  }
})
