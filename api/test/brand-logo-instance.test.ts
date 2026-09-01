import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerOrganizationRoutes } from '../src/routes/organizations.js'

/**
 * `GET /api/brand/logo` paints the unauthenticated sign-in screen, so it is
 * instance state. It used to serve "the one organisation's logo, if the
 * instance holds exactly one organisation": under per-UOA-org tenancy that is
 * routinely false (branding silently stopped working), and while it held, one
 * tenant's admins controlled the login screen everybody sees. The organisation
 * that brands the instance is now designated by the instance operator
 * (`Organization.instanceBrand`, set by `nessie set-instance-brand`).
 */

const organizationId = '00000000-0000-4000-8000-0000000000c1'
const otherOrganizationId = '00000000-0000-4000-8000-0000000000c2'
const attachmentId = '00000000-0000-4000-8000-0000000000c3'
const userId = '00000000-0000-4000-8000-0000000000c4'

type OrganizationRow = {
  conversationalSetupEnabled: boolean
  createdAt: Date
  id: string
  instanceBrand: boolean
  logoAttachmentId: string | null
  name: string
  stripImageMetadata: boolean
}

type Membership = {
  deactivatedAt: Date | null
  role: 'admin' | 'member' | 'owner'
}

const makeApp = (
  organizations: OrganizationRow[],
  membership: Membership = { role: 'admin', deactivatedAt: null },
) => {
  const updates: Array<Record<string, unknown>> = []
  const prisma = {
    organization: {
      count: async () => {
        throw new Error('brand logo must not be decided by counting organisations')
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          instanceBrand?: boolean
          logoAttachmentId?: { not: null }
        }
        return (
          organizations.find(
            (organization) =>
              (where.instanceBrand === undefined
                || organization.instanceBrand === where.instanceBrand)
              && (where.logoAttachmentId === undefined
                || organization.logoAttachmentId !== null),
          ) ?? null
        )
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        organizations.find((organization) => organization.id === where.id) ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        return { ...organizations[0], ...data }
      },
    },
    organizationMember: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (
          where.role !== membership.role
          || where.deactivatedAt !== membership.deactivatedAt
        ) {
          return null
        }
        return membership
      },
      findUnique: async () => membership,
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerOrganizationRoutes(app, {
    prisma,
    fileService: {
      openStream: async (id: string, orgId: string) => ({
        attachment: {
          id,
          mime: 'image/png',
          organizationId: orgId,
          sizeBytes: BigInt(3),
        },
        stream: Readable.from([Buffer.from('png')]),
      }),
    },
    requireActorContext: () =>
      ({
        actionContext: { requestId: 'request-brand-logo' },
        actor: { actorId: userId, actorType: 'user', roles: ['admin'] },
        tenant: { organizationId },
      }) as unknown as AuthorizedActionContext,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerOrganizationRoutes>[1])
  return { app, updates }
}

const organizationRow = (overrides: Partial<OrganizationRow> = {}): OrganizationRow => ({
  conversationalSetupEnabled: false,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  id: organizationId,
  instanceBrand: false,
  logoAttachmentId: attachmentId,
  name: 'Acme',
  stripImageMetadata: true,
  ...overrides,
})

test('the designated organisation brands the sign-in screen', async () => {
  const { app } = makeApp([organizationRow({ instanceBrand: true })])
  const response = await app.inject({ method: 'GET', url: '/api/brand/logo' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
})

test('a sole organisation that was never designated does not brand the instance', async () => {
  // The old rule was "exactly one organisation on the instance wins". It is
  // gone: designation is explicit, so nothing is inherited from being alone.
  const { app } = makeApp([organizationRow({ instanceBrand: false })])
  const response = await app.inject({ method: 'GET', url: '/api/brand/logo' })
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().error.code, 'BRAND_LOGO_NOT_FOUND')
})

test('with several organisations only the designated one is served', async () => {
  const { app } = makeApp([
    organizationRow({ id: otherOrganizationId, instanceBrand: false, name: 'Other' }),
    organizationRow({ instanceBrand: true }),
  ])
  const response = await app.inject({ method: 'GET', url: '/api/brand/logo' })
  // Multiple organisations no longer 404 the endpoint — that was the silent
  // breakage — and a non-designated organisation cannot claim the screen.
  assert.equal(response.statusCode, 200)
})

test('a designated organisation with no logo falls back to the Nessie mark', async () => {
  const { app } = makeApp([organizationRow({ instanceBrand: true, logoAttachmentId: null })])
  const response = await app.inject({ method: 'GET', url: '/api/brand/logo' })
  assert.equal(response.statusCode, 404)
})

test('an organisation admin cannot designate their own organisation through the org PATCH', async () => {
  const { app, updates } = makeApp([organizationRow()])
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/organizations/current',
    payload: { instanceBrand: true, name: 'Acme Renamed' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(updates.length, 1)
  assert.equal('instanceBrand' in (updates[0] ?? {}), false)
})

test('only an active owner may change conversational setup early access', async () => {
  const { app, updates } = makeApp(
    [organizationRow()],
    { role: 'owner', deactivatedAt: null },
  )
  const response = await app.inject({
    method: 'PUT',
    url: '/api/organizations/current/features/conversational-setup',
    payload: { conversationalSetupEnabled: true },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0], { conversationalSetupEnabled: true })
  assert.equal(response.json().data.conversationalSetupEnabled, true)
})

test('an administrator without the owner role cannot change conversational setup early access', async () => {
  const { app, updates } = makeApp(
    [organizationRow()],
    { role: 'admin', deactivatedAt: null },
  )
  const response = await app.inject({
    method: 'PUT',
    url: '/api/organizations/current/features/conversational-setup',
    payload: { conversationalSetupEnabled: true },
  })

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'FORBIDDEN')
  assert.deepEqual(updates, [])
})

test('a deactivated owner cannot change conversational setup early access', async () => {
  const { app, updates } = makeApp(
    [organizationRow()],
    { role: 'owner', deactivatedAt: new Date('2026-09-01T12:00:00.000Z') },
  )
  const response = await app.inject({
    method: 'PUT',
    url: '/api/organizations/current/features/conversational-setup',
    payload: { conversationalSetupEnabled: true },
  })

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'FORBIDDEN')
  assert.deepEqual(updates, [])
})

test('the conversational setup route accepts only its boolean setting', async () => {
  const { app, updates } = makeApp(
    [organizationRow()],
    { role: 'owner', deactivatedAt: null },
  )
  const response = await app.inject({
    method: 'PUT',
    url: '/api/organizations/current/features/conversational-setup',
    payload: { conversationalSetupEnabled: true, name: 'Must not be accepted' },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(updates, [])
})

test('the migration backfills the single-organisation instance and nothing else', () => {
  const migrationSql = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../prisma/migrations/20260816100000_organization_instance_brand/migration.sql',
    ),
    'utf8',
  )
  assert.match(migrationSql, /ADD COLUMN "instance_brand" BOOLEAN NOT NULL DEFAULT false/)
  assert.match(
    migrationSql,
    /UPDATE "organizations"[\s\S]*SET "instance_brand" = true[\s\S]*WHERE \(SELECT count\(\*\) FROM "organizations"\) = 1/,
  )
})
