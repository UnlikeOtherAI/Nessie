// Full non-workflow trigger proof against the deterministic mock LLM.
//
// An owner, acting through the Personal Assistant's shared tool path, creates
// all five agent trigger types. Their real dispatch paths then create runs
// through the queue and the mock LLM completes each one:
//
//   manual + webhook → API dispatch, event → worker event fan-out,
//   scheduled + interval → scheduler sweep → agent completion.
//
// Run: pnpm --filter @nessie/worker test:triggers
// Requires a dedicated, migrated DATABASE_URL. It seeds and removes one
// isolated org, but the scheduler itself is global and must not share dev data.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

if (!process.env.DATABASE_URL) {
  throw new Error(
    'test:triggers needs DATABASE_URL for a dedicated, freshly migrated test database. '
    + 'It drives the global scheduler and must not share a developer database.',
  )
}

process.env.NESSIE_DB_URL ??= process.env.DATABASE_URL
process.env.NESSIE_MODEL_PROVIDER ??= 'openai'
process.env.NESSIE_MODEL_API_KEY ??= 'mock-token'
process.env.OPENAI_API_KEY ??= 'mock-token'

type TriggerType = 'event' | 'interval' | 'manual' | 'scheduled' | 'webhook'

const EXPECTED_ANSWER = 'This is a deterministic mock answer, streamed in fixed-size chunks.'

const main = async (): Promise<void> => {
  const { createMockLlmServer, loadScenario } = await import('@nessie/mock-llm')
  const server = await createMockLlmServer({ scenario: await loadScenario('simple-answer') })
  process.env.NESSIE_MODEL_BASE_URL = `${server.url}/v1`

  const { dispatchAgentTrigger } = await import('../../api/src/services/trigger-dispatch.js')
  const { dispatchEventTriggers } = await import('../src/control/trigger-events.js')
  const { sweepDueScheduledTriggers } = await import('../src/control/trigger-scheduler.js')
  const { runAgentTriggerCreateTool } = await import('../src/run/pa-tools/provisioning.js')
  const {
    cleanupScope,
    seedScope,
    startMockPipeline,
  } = await import('./pipeline.js')
  const { assertGlobalQueuesQuiet } = await import('../test/db/support.js')

  const pipeline = await startMockPipeline({ workers: 1 })
  const scope = await seedScope(pipeline.prisma, 'triggers')
  const runIds: string[] = []
  const now = new Date()

  const actorContext = {
    actionContext: { requestId: randomUUID(), teamId: scope.teamId },
    actor: { actorId: scope.userId, actorType: 'user' as const, roles: ['owner'] },
    tenant: {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      teamId: scope.teamId,
    },
  }

  try {
    await assertGlobalQueuesQuiet(pipeline.prisma)

    await pipeline.prisma.organizationMember.create({
      data: { organizationId: scope.organizationId, role: 'owner', userId: scope.userId },
    })
    await pipeline.prisma.teamMember.create({
      data: { teamId: scope.teamId, userId: scope.userId },
    })
    await pipeline.prisma.agentBinding.create({
      data: { agentId: scope.agentId, channelId: scope.channelId },
    })

    const toolContext = {
      actorContext,
      agentId: 'personal-assistant-1',
      agentKind: 'personal_assistant' as const,
      channel: { id: scope.channelId, organizationId: scope.organizationId },
      prisma: pipeline.prisma,
      realtimeTransport: {},
      run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
      toolCallId: randomUUID(),
    } as unknown as BuiltinToolRuntimeContext

    // A trigger's target thread is durable. Give each delivery its own
    // conversation so the single-turn mock scenario proves the fire itself,
    // rather than accumulating prior assistant turns from a different trigger.
    const targetThreads = await Promise.all(
      Array.from({ length: 5 }, () => pipeline.prisma.thread.create({
        data: { channelId: scope.channelId },
        select: { id: true },
      })),
    )
    const definitions: Array<{
      config?: Record<string, unknown>
      name: string
      nextRunAt?: string
      targetThreadId: string
      type: TriggerType
    }> = [
      { name: 'manual', targetThreadId: targetThreads[0]!.id, type: 'manual' },
      {
        config: { cron: '*/30 * * * *', prompt: 'Publish the scheduled report' },
        name: 'scheduled',
        nextRunAt: new Date(now.getTime() - 120_000).toISOString(),
        targetThreadId: targetThreads[1]!.id,
        type: 'scheduled',
      },
      {
        config: { interval_minutes: 15, prompt: 'Check the system again' },
        name: 'interval',
        nextRunAt: new Date(now.getTime() - 60_000).toISOString(),
        targetThreadId: targetThreads[2]!.id,
        type: 'interval',
      },
      { name: 'webhook', targetThreadId: targetThreads[3]!.id, type: 'webhook' },
      {
        config: { events: ['release.shipped'], filter: { region: 'eu' } },
        name: 'event',
        targetThreadId: targetThreads[4]!.id,
        type: 'event',
      },
    ]

    const triggers = new Map<TriggerType, { id: string; nextRunAt: Date | null }>()
    for (const definition of definitions) {
      const result = await runAgentTriggerCreateTool(toolContext, {
        agentId: scope.agentId,
        config: definition.config,
        name: definition.name,
        nextRunAt: definition.nextRunAt,
        targetChannelId: scope.channelId,
        targetThreadId: definition.targetThreadId,
        type: definition.type,
      })
      assert.equal(result.toolName, 'agent_trigger_create')

      const trigger = await pipeline.prisma.agentTrigger.findFirstOrThrow({
        select: { id: true, nextRunAt: true, type: true },
        where: { agentId: scope.agentId, name: definition.name },
      })
      assert.equal(trigger.type, definition.type)
      triggers.set(definition.type, trigger)
    }

    const webhook = await pipeline.prisma.agentTrigger.findFirstOrThrow({
      select: { config: true },
      where: { id: triggers.get('webhook')?.id },
    })
    assert.match(String((webhook.config as Record<string, unknown>)['apiKey']), /^ntk_/)
    const event = await pipeline.prisma.agentTrigger.findFirstOrThrow({
      select: { config: true },
      where: { id: triggers.get('event')?.id },
    })
    assert.deepEqual((event.config as Record<string, unknown>)['events'], ['release.shipped'])

    const waitFor = async (runId: string, triggerId: string, payload: unknown) => {
      runIds.push(runId)
      const terminal = await pipeline.waitForTerminalRuns([runId])
      assert.equal(terminal.get(runId), 'completed')

      const delivery = await pipeline.prisma.agentTriggerDelivery.findFirstOrThrow({
        select: { payload: true, run: { select: { id: true } }, status: true },
        where: { run: { is: { id: runId } }, triggerId },
      })
      assert.equal(delivery.status, 'delivered')
      assert.equal(delivery.run?.id, runId)
      assert.deepEqual(delivery.payload, payload)

      const answer = await pipeline.prisma.message.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { content: true },
        where: { agentId: scope.agentId, role: 'assistant' },
      })
      assert.equal(answer?.content, EXPECTED_ANSWER)
    }

    const manualPayload = { requestedBy: 'owner', task: { id: 7, title: 'Deploy check' } }
    const manual = await dispatchAgentTrigger(pipeline.prisma, {
      dedupeKey: randomUUID(),
      payload: manualPayload,
      source: 'manual',
      triggerId: triggers.get('manual')!.id,
    })
    assert.equal(manual.kind, 'queued')
    assert.ok(manual.runId)
    if (manual.kind === 'queued' && manual.runId) {
      await waitFor(manual.runId, triggers.get('manual')!.id, manualPayload)
    }

    const webhookPayload = { build: { id: 'build-42', state: 'passed' }, labels: ['release', 'eu'] }
    const webhookFire = await dispatchAgentTrigger(pipeline.prisma, {
      dedupeKey: randomUUID(),
      payload: webhookPayload,
      source: 'webhook',
      triggerId: triggers.get('webhook')!.id,
    })
    assert.equal(webhookFire.kind, 'queued')
    assert.ok(webhookFire.runId)
    if (webhookFire.kind === 'queued' && webhookFire.runId) {
      await waitFor(webhookFire.runId, triggers.get('webhook')!.id, webhookPayload)
    }

    const eventPayload = { region: 'eu', version: '2026.09.04' }
    await dispatchEventTriggers(pipeline.prisma, {
      actorContext,
      dedupeKey: randomUUID(),
      eventType: 'release.shipped',
      payload: eventPayload,
      source: 'event:release.shipped',
    })
    const eventRun = await pipeline.prisma.run.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      where: { triggerId: triggers.get('event')!.id },
    })
    await waitFor(eventRun.id, triggers.get('event')!.id, {
      eventType: 'release.shipped',
      ...eventPayload,
    })

    await sweepDueScheduledTriggers(pipeline.prisma, { limit: 2, now })
    for (const type of ['scheduled', 'interval'] as const) {
      const trigger = triggers.get(type)!
      const scheduledRun = await pipeline.prisma.run.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
        select: { id: true },
        where: { triggerId: trigger.id },
      })
      await waitFor(scheduledRun.id, trigger.id, {
        scheduledFor: trigger.nextRunAt?.toISOString(),
        triggerId: trigger.id,
      })
      const rearmed = await pipeline.prisma.agentTrigger.findUniqueOrThrow({
        select: { nextRunAt: true },
        where: { id: trigger.id },
      })
      assert.ok(rearmed.nextRunAt && rearmed.nextRunAt > now, `${type} was rearmed`)
    }

    // Every trigger must reach inference. The agent loop can legitimately make
    // a follow-up model request (for example to compact a carried context), so
    // this asserts the durable five-run outcome rather than an implementation
    // detail of how many model turns one run happens to need.
    assert.ok(server.stats().requests >= runIds.length, 'each trigger reached the agent loop')
    console.log('[trigger-smoke] PASS: PA creation + all five agent trigger dispatch paths')
  } finally {
    await cleanupScope(pipeline.prisma, pipeline.pool, scope, runIds)
    await pipeline.stop()
    await server.close()
  }
}

main().catch((error: unknown) => {
  console.error('[trigger-smoke] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
