import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { seedPublicConnectors } from '../src/db/seed-connectors.js'

type UpsertArgs = {
  where: { id: string }
  update: Record<string, unknown>
  create: Record<string, unknown>
}

const makePrismaStub = (): {
  prisma: PrismaClient
  upserts: UpsertArgs[]
} => {
  const upserts: UpsertArgs[] = []
  const prisma = {
    organizationMember: {
      findFirst: async () => ({
        userId: '00000000-0000-4000-8000-000000000001',
      }),
    },
    mcpCatalogEntry: {
      upsert: async (args: UpsertArgs) => {
        upserts.push(args)
        return args.create
      },
    },
  }

  return { prisma: prisma as unknown as PrismaClient, upserts }
}

test('seedPublicConnectors publishes deep.agent crawl as the web scanning template', async () => {
  const { prisma, upserts } = makePrismaStub()

  const result = await seedPublicConnectors(prisma)

  assert.equal(result.seeded, 2)
  const crawl = upserts.find(
    (entry) => entry.where.id === 'b0c7e6d2-7e2a-4f1a-9c3e-000000000002',
  )
  assert.ok(crawl)
  assert.equal(crawl.create.name, 'deep-agent-crawl')
  assert.equal(crawl.create.label, 'deep.agent Crawl')
  assert.equal(crawl.create.vendor, 'deep.agent')
  assert.equal(crawl.create.sourceUrl, 'https://deep.agent')
  assert.equal(crawl.create.protocol, 'sse')
  assert.equal(crawl.create.authMethod, 'bearer')
  assert.deepEqual(crawl.create.defaultTransportConfig, {})

  assert.equal(crawl.update.name, 'deep-agent-crawl')
  assert.equal(crawl.update.label, 'deep.agent Crawl')
  assert.equal(crawl.update.vendor, 'deep.agent')
  assert.equal(crawl.update.sourceUrl, 'https://deep.agent')
})
