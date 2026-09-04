import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerMailboxRoutes } from '../src/routes/mailbox.js'
import { registerDesignerRoutes } from '../src/routes/designer.js'
import { registerThoughtRoutes } from '../src/routes/thoughts.js'

const actorContext = {
  actionContext: { requestId: 'secret-ingestion-test' },
  actor: { actorId: '20000000-0000-4000-8000-000000000001', actorType: 'user' },
  tenant: { organizationId: '10000000-0000-4000-8000-000000000001' },
}

test('direct memory capture refuses credentials before reaching the memory service', async () => {
  const app = Fastify()
  registerThoughtRoutes(app, {
    prisma: {},
    requireActorContext: () => actorContext,
    thoughtService: null,
  } as never)
  await app.ready()
  const response = await app.inject({
    method: 'POST',
    payload: { content: 'STRIPE_SECRET_KEY=abcdefghijklmnopqrstuvwxyz123456' },
    url: '/api/thoughts',
  })

  assert.equal(response.statusCode, 422)
  assert.equal(response.json().error.code, 'SECRET_INTERCEPTED')
  await app.close()
})

test('direct mailbox creation refuses credentials before reaching Prisma', async () => {
  const app = Fastify()
  registerMailboxRoutes(app, {
    prisma: {},
    requireActorContext: () => actorContext,
    requireOwner: () => true,
  } as never)
  await app.ready()
  const response = await app.inject({
    method: 'POST',
    payload: { body: 'token=abcdefghijklmnopqrstuvwxyz123456' },
    url: '/api/mailbox',
  })

  assert.equal(response.statusCode, 422)
  assert.equal(response.json().error.code, 'SECRET_INTERCEPTED')
  await app.close()
})

test('the Agent Designer refuses credentials before model or chat persistence', async () => {
  const app = Fastify()
  registerDesignerRoutes(app, {
    prisma: {},
    requireActorContext: () => actorContext,
  } as never)
  await app.ready()
  const formState = {
    model: '',
    name: '',
    provider: '',
    role: '',
    systemPrompt: 'password="hunter2"',
    tools: {},
  }
  const sidebar = await app.inject({
    method: 'POST',
    payload: { formState, messages: [] },
    url: '/api/designer/chat',
  })
  const handoff = await app.inject({
    method: 'POST',
    payload: { formState },
    url: '/api/designer/continue-in-chat',
  })

  assert.equal(sidebar.statusCode, 422)
  assert.equal(sidebar.json().error.code, 'SECRET_INTERCEPTED')
  assert.equal(handoff.statusCode, 422)
  assert.equal(handoff.json().error.code, 'SECRET_INTERCEPTED')
  await app.close()
})
