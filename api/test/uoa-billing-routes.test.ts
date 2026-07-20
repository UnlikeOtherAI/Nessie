import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'
import { registerBillingRoutes } from '../src/routes/billing.js'

const context = (
  role: 'member' | 'owner',
): AuthorizedActionContext => ({
  actionContext: { requestId: `billing-${role}` },
  actor: {
    actorId: '00000000-0000-4000-8000-000000000001',
    actorType: 'user',
    roles: [role],
  },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
})

const makeApp = (role: 'member' | 'owner') => {
  const app = Fastify({ logger: false })
  registerBillingRoutes(app, {
    prisma: {},
    requireActorContext: () => context(role),
  } as never)
  return app
}

test('legacy summary and direct action routes are removed', async () => {
  const app = makeApp('owner')
  try {
    for (const request of [
      { method: 'GET' as const, url: '/api/billing/subscription' },
      { method: 'POST' as const, url: '/api/billing/checkout' },
      { method: 'POST' as const, url: '/api/billing/portal' },
    ]) {
      const response = await app.inject(request)
      assert.equal(response.statusCode, 404, request.url)
    }
  } finally {
    await app.close()
  }
})

test('browser cannot submit an action path, subject, or request body', async () => {
  const app = makeApp('owner')
  try {
    const response = await app.inject({
      method: 'POST',
      payload: {
        path: 'https://example.com',
        organisation_id: 'other-org',
      },
      url: '/api/billing/actions/upgrade',
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'VALIDATION_ERROR')
  } finally {
    await app.close()
  }
})

test('confirmation accepts no fields beyond the opaque UOA protocol', async () => {
  const app = makeApp('owner')
  try {
    const response = await app.inject({
      method: 'POST',
      payload: {
        preview_token: `uoa_cancel_${'t'.repeat(43)}`,
        idempotency_key: `uoa_confirm_${'i'.repeat(43)}`,
        selection: 'current_service',
        service_ids: ['forged-service'],
      },
      url: '/api/billing/cancellation/confirm',
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'VALIDATION_ERROR')
  } finally {
    await app.close()
  }
})

test('the canonical statement is restricted to billing managers', async () => {
  const app = makeApp('member')
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/billing/statement',
    })
    assert.equal(response.statusCode, 403)
  } finally {
    await app.close()
  }
})

