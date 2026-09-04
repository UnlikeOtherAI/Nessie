import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createWorkflowTrigger } from '../src/workflow-trigger-create.js'

const installationId = randomUUID()

const createPrisma = () => {
  const created: Array<Record<string, unknown>> = []
  const prisma = {
    workflowInstallation: {
      findUnique: async () => ({ id: installationId }),
    },
    agentTrigger: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        const now = new Date('2026-09-04T08:00:00.000Z')
        return {
          agentId: null,
          config: data.config ?? {},
          createdAt: now,
          description: data.description ?? null,
          enabled: data.enabled ?? true,
          id: randomUUID(),
          lastFiredAt: null,
          name: data.name ?? null,
          nextRunAt: data.nextRunAt ?? null,
          status: data.status ?? 'active',
          targetChannelId: null,
          targetThreadId: null,
          type: data.type,
          updatedAt: now,
          workflowInstallationId: data.workflowInstallationId,
        }
      },
    },
  } as unknown as PrismaClient
  return { created, prisma }
}

test('workflow trigger creation covers every supported launch type', async () => {
  const cases = [
    { type: 'manual' as const },
    {
      config: { mode: 'once', at: '2026-09-05T09:00:00.000Z' },
      nextRunAt: '2026-09-05T09:00:00.000Z',
      type: 'scheduled' as const,
    },
    {
      config: { cron: '0 9 * * 1-5', timezone: 'Europe/London' },
      type: 'scheduled' as const,
    },
    { config: { interval_minutes: 15 }, type: 'interval' as const },
    { type: 'webhook' as const },
    { config: { events: ['document.published'] }, type: 'event' as const },
  ]

  for (const input of cases) {
    const { created, prisma } = createPrisma()
    const trigger = await createWorkflowTrigger(prisma, installationId, input)
    assert.ok(trigger, `expected ${input.type} trigger to be created`)
    assert.equal(trigger.type, input.type)
    assert.equal(created[0]?.['workflowInstallationId'], installationId)
    if (input.type === 'scheduled' || input.type === 'interval') {
      assert.ok(trigger.nextRunAt, `expected ${input.type} trigger to be armed`)
    }
  }
})

test('workflow trigger creation rejects a malformed fixed interval', async () => {
  const { prisma } = createPrisma()
  const trigger = await createWorkflowTrigger(prisma, installationId, {
    config: { interval_minutes: 0 },
    type: 'interval',
  })
  assert.equal(trigger, null)
})

test('workflow trigger creation never accepts server-owned config provenance', async () => {
  const { created, prisma } = createPrisma()
  await createWorkflowTrigger(prisma, installationId, {
    config: { createdByUserId: randomUUID(), createdViaTool: true },
    type: 'manual',
  })
  assert.deepEqual(created[0]?.['config'], {})
})
