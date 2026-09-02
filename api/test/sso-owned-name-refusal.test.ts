import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerOrganizationRoutes } from '../src/routes/organizations.js'

/**
 * An organisation bound to UnlikeOtherAI is named there, and `Organization.name`
 * is only a mirror: `syncExternalOrganizationNames` overwrites it from the
 * verified directory at every login and rotation. The route used to accept a
 * local rename anyway, so the value persisted just long enough to look saved
 * and was then silently reverted — Nessie acting as a second, losing authority.
 *
 * These drive the real handler, so they fail if the guard is removed rather
 * than merely if a schema changes.
 */

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000005'

const makeApp = (externalOrgId: string | null) => {
  let updates = 0
  const organization = {
    id: organizationId,
    name: 'Acme Ltd',
    externalOrgId,
    logoAttachmentId: null,
    stripImageMetadata: true,
    conversationalSetupEnabled: false,
  }

  const prisma = {
    organization: {
      findUnique: async ({ select }: { select?: Record<string, true> }) => {
        if (!select) return organization
        return Object.fromEntries(
          Object.keys(select).map((key) => [key, organization[key as keyof typeof organization]]),
        )
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates += 1
        Object.assign(organization, data)
        return organization
      },
    },
    organizationMember: {
      findUnique: async () => ({ organizationId, userId, role: 'owner' }),
    },
  }

  const actorContext = {
    actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId },
    actionContext: {},
  } as unknown as AuthorizedActionContext

  const app = Fastify({ logger: false })
  registerOrganizationRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerOrganizationRoutes>[1])

  return { app, organization, get updates() { return updates } }
}

test('renaming an SSO-bound organisation is refused, and nothing is written', async () => {
  const ctx = makeApp('uoa-org-123')

  const response = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/organizations/current',
    payload: { name: 'Renamed Locally' },
  })

  assert.equal(response.statusCode, 409)
  assert.equal(JSON.parse(response.body).error.code, 'ORGANIZATION_NAME_MANAGED_BY_SSO')
  // The refusal has to be a refusal, not a 409 after the write landed.
  assert.equal(ctx.updates, 0)
  assert.equal(ctx.organization.name, 'Acme Ltd')
})

test('a local organisation with no IdP can still be renamed', async () => {
  const ctx = makeApp(null)

  const response = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/organizations/current',
    payload: { name: 'Renamed Locally' },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(ctx.organization.name, 'Renamed Locally')
})

test('an SSO-bound organisation still accepts its own Nessie-owned settings', async () => {
  const ctx = makeApp('uoa-org-123')

  // The logo and the metadata flag are Nessie's, not UOA's. Refusing the name
  // must not turn the whole record read-only.
  const response = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/organizations/current',
    payload: { stripImageMetadata: false },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(ctx.organization.stripImageMetadata, false)
})

test('resending the unchanged name is an ordinary edit, not a refusal', async () => {
  const ctx = makeApp('uoa-org-123')

  // A form echoing the stored value back must not be treated as a rename, or
  // every save of an unrelated field from a populated form would 409.
  const response = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/organizations/current',
    payload: { name: 'Acme Ltd' },
  })

  assert.equal(response.statusCode, 200)
})
