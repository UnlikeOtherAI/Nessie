import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { LOCAL_INFERENCE_ENABLED_SETTING_KEY } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerLocalInferenceDesktopEnrollmentRoute } from '../src/routes/local-inference-desktop-enrollment.js'

const organizationId = '00000000-0000-4000-8000-0000000000d1'
const ownerId = '00000000-0000-4000-8000-0000000000d2'
const hostId = '00000000-0000-4000-8000-0000000000d3'

type Host = {
  custodianUserId: string
  id: string
  organizationId: string
  revokedAt: Date | null
  transport: 'desktop' | 'executor'
}

const publicKey = (): string => crypto.generateKeyPairSync('ed25519').publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString()

const makeApp = (initial: Host | null = null) => {
  let stored = initial
  let creates = 0
  const prisma = {
    localInferenceHost: {
      create: async ({ data }: { data: { custodianUserId: string; organizationId: string } }) => {
        creates += 1
        if (stored) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        stored = {
          custodianUserId: data.custodianUserId,
          id: hostId,
          organizationId: data.organizationId,
          revokedAt: null,
          transport: 'desktop',
        }
        return { id: hostId }
      },
      findUnique: async () => stored,
    },
    scopedSetting: {
      findMany: async () => [{
        key: LOCAL_INFERENCE_ENABLED_SETTING_KEY,
        locked: false,
        scope: 'organization',
        updatedAt: new Date(),
        value: true,
      }],
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerLocalInferenceDesktopEnrollmentRoute(app, {
    prisma,
    requireActorContext: () => ({
      actionContext: { requestId: 'local-inference-enrollment' },
      actor: { actorId: ownerId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId },
    }) as unknown as AuthorizedActionContext,
    requireUserActor: () => true,
  } as never)
  return { app, creates: () => creates }
}

const enroll = (app: ReturnType<typeof makeApp>['app'], key: string) => app.inject({
  method: 'POST',
  payload: { displayLabel: 'Nessie Desktop', publicKey: key },
  url: '/api/local-inference/hosts/enroll',
})

test('repeated Desktop Prepare reuses the exact active owner host', async () => {
  const { app, creates } = makeApp()
  const key = publicKey()

  const first = await enroll(app, key)
  const second = await enroll(app, key)

  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(first.json().data.hostId, hostId)
  assert.equal(second.json().data.hostId, hostId)
  assert.equal(creates(), 1)
})

test('a revoked Desktop fingerprint requires native key rotation', async () => {
  const { app, creates } = makeApp({
    custodianUserId: ownerId,
    id: hostId,
    organizationId,
    revokedAt: new Date(),
    transport: 'desktop',
  })

  const response = await enroll(app, publicKey())

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error.code, 'KEY_ROTATION_REQUIRED')
  assert.equal(creates(), 0)
})
