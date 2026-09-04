import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerConnectedMailRoutes } from '../src/routes/connected-mail.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

const context = (actorType: 'agent' | 'user' = 'user'): AuthorizedActionContext => ({
  actor: { actorId: USER_ID, actorType, roles: ['member'] },
  actionContext: { requestId: 'connected-mail-route-test' },
  tenant: { organizationId: ORGANIZATION_ID },
})

const makeApp = (input: { actorType?: 'agent' | 'user'; authenticated?: boolean } = {}) => {
  const seen = { comms: [] as unknown[], mailboxes: [] as unknown[] }
  const prisma = {
    commsConnection: {
      findMany: async (args: unknown) => {
        seen.comms.push(args)
        return [{
          disabledCapabilities: [], externalUserId: 'person@example.test', grantedScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
          ], id: ACCOUNT_ID, status: 'active',
        }]
      },
    },
    mailboxConnection: {
      findMany: async (args: unknown) => {
        seen.mailboxes.push(args)
        return []
      },
    },
  } as unknown as PrismaClient
  const app = Fastify()
  registerConnectedMailRoutes(app, {
    allowedCorsOrigins: new Set(),
    authSecret: 'test-secret',
    config: { mode: 'local' },
    isJsonContentType: (request: { headers: Record<string, string | undefined> }) =>
      /^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''),
    parseHeaderValue: (value: string | string[] | undefined) =>
      typeof value === 'string' ? value.trim() || undefined : undefined,
    prisma,
    requireActorContext: (_request: unknown, reply: { code: (status: number) => { send: (body: unknown) => void } }) => {
      if (input.authenticated === false) {
        reply.code(401).send({ error: { code: 'UNAUTHORIZED' } })
        return null
      }
      return context(input.actorType)
    },
    requireUserActor: (value: AuthorizedActionContext, reply: { code: (status: number) => { send: (body: unknown) => void } }) => {
      if (value.actor.actorType === 'user') return true
      reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
  } as never)
  return { app, seen }
}

test('mail accounts are user-only, private no-store, and tenant-scoped', async () => {
  const { app, seen } = makeApp()
  await app.ready()
  try {
    const response = await app.inject({ method: 'GET', url: '/api/mail/accounts' })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    assert.equal(response.json().data[0].id, ACCOUNT_ID)
    assert.deepEqual(seen.comms[0], {
      select: {
        disabledCapabilities: true, externalUserId: true, grantedScopes: true, id: true, status: true,
      },
      where: { organizationId: ORGANIZATION_ID, ownerUserId: USER_ID, provider: 'google', status: { not: 'disconnected' } },
    })
    const mailboxWhere = (seen.mailboxes[0] as { where: unknown }).where
    assert.match(JSON.stringify(mailboxWhere), new RegExp(ORGANIZATION_ID))
    assert.match(JSON.stringify(mailboxWhere), new RegExp(USER_ID))
  } finally {
    await app.close()
  }
})

test('mail routes require an authenticated human actor', async () => {
  const unauthenticated = makeApp({ authenticated: false })
  const agent = makeApp({ actorType: 'agent' })
  await Promise.all([unauthenticated.app.ready(), agent.app.ready()])
  try {
    assert.equal((await unauthenticated.app.inject({ method: 'GET', url: '/api/mail/accounts' })).statusCode, 401)
    assert.equal((await agent.app.inject({ method: 'GET', url: '/api/mail/accounts' })).statusCode, 403)
  } finally {
    await Promise.all([unauthenticated.app.close(), agent.app.close()])
  }
})

test('thread routes refuse invalid params and query before provider work', async () => {
  const { app } = makeApp()
  await app.ready()
  try {
    const source = await app.inject({ method: 'GET', url: `/api/mail/accounts/nope/${ACCOUNT_ID}/threads` })
    assert.equal(source.statusCode, 400)
    const query = await app.inject({ method: 'GET', url: `/api/mail/accounts/gmail/${ACCOUNT_ID}/threads?pageSize=101` })
    assert.equal(query.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('mail mutations require an allowed origin, JSON and a non-empty body', async () => {
  const { app } = makeApp()
  await app.ready()
  try {
    const url = `/api/mail/accounts/gmail/${ACCOUNT_ID}/drafts`
    const headers = { origin: 'http://localhost:5455', 'content-type': 'application/json' }
    const noOrigin = await app.inject({ method: 'POST', url, payload: { to: ['a@example.test'] } })
    assert.equal(noOrigin.statusCode, 403)
    const form = await app.inject({
      method: 'POST',
      url,
      headers: { origin: headers.origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'to=a%40example.test',
    })
    assert.equal(form.statusCode, 415)
    const empty = await app.inject({ method: 'POST', url, headers, payload: {} })
    assert.equal(empty.statusCode, 400)
    const foreign = await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.example' }, payload: { to: ['a@example.test'] } })
    assert.equal(foreign.statusCode, 403)
  } finally {
    await app.close()
  }
})

test('mail contracts refuse supplied From and unknown fields before a send or draft', async () => {
  const { app } = makeApp()
  await app.ready()
  try {
    const headers = { origin: 'http://localhost:5455', 'content-type': 'application/json' }
    const payload = { body: 'Hello', from: 'spoof@example.test', subject: 'Hi', to: ['recipient@example.test'] }
    const draft = await app.inject({
      method: 'POST', url: `/api/mail/accounts/gmail/${ACCOUNT_ID}/drafts`, headers, payload,
    })
    assert.equal(draft.statusCode, 400)
    const send = await app.inject({
      method: 'POST', url: `/api/mail/accounts/mailbox/${ACCOUNT_ID}/send`, headers, payload,
    })
    assert.equal(send.statusCode, 400)
  } finally {
    await app.close()
  }
})
