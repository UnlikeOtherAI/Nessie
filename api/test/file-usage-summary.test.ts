import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerLedgerRoutes } from '../src/routes/ledger.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-00000000000a'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['owner'] },
  tenant: { organizationId },
  actionContext: { requestId: 'req-file-usage' },
}

test('file usage summary reports current storage and transfer bytes', async () => {
  const app = Fastify({ logger: false })
  const prisma = {
    attachment: {
      aggregate: async () => ({
        _count: { id: 2 },
        _sum: { sizeBytes: 3072 },
      }),
    },
    connectorUsageEvent: {
      aggregate: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.organizationId, organizationId)
        assert.equal(where.connectorType, 'storage')
        assert.equal(where.unitType, 'bytes')
        return {
          _count: { id: 3 },
          _sum: { units: 6144 },
        }
      },
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        assert.equal(where.organizationId, organizationId)
        assert.equal(where.connectorType, 'storage')
        assert.equal(where.unitType, 'bytes')
        return [
          { operation: 'download', _count: { id: 2 }, _sum: { units: 4096 } },
          { operation: 'upload', _count: { id: 1 }, _sum: { units: 2048 } },
        ]
      },
    },
  } as unknown as PrismaClient

  registerLedgerRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
  } as unknown as Parameters<typeof registerLedgerRoutes>[1])

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ledger/files/summary',
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data, {
      currentStoredBytes: 3072,
      currentAttachmentCount: 2,
      totalTransferBytes: 6144,
      totalTransferEvents: 3,
      uploadBytes: 2048,
      downloadBytes: 4096,
      breakdowns: [
        { key: 'download', bytes: 4096, events: 2 },
        { key: 'upload', bytes: 2048, events: 1 },
      ],
    })
  } finally {
    await app.close()
  }
})
