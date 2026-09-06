// Shared full-pipeline driver for the mock-LLM harness (smoke + load).
//
// Entrypoints MUST set process.env (DATABASE_URL, NESSIE_MODEL_*,
// OPENAI_API_KEY) before importing this module: worker/src/run/agent-loop.ts
// reads loadConfig() at module load time, so the mock provider URL has to be
// in place before the worker code is first imported.
import { randomUUID } from 'node:crypto'
import { loadConfig } from '@nessie/config'
import { disconnectPrismaClient, enqueueQueueJob, getPrismaClient } from '@nessie/db'
import {
  createModelClient,
  createPgPool,
  PgQueueProvider,
  PgRealtimeTransport,
} from '@nessie/runtime'
import {
  RunExecuteJobPayloadSchema,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { executeRunJob } from '../src/run/execute.js'
import type { ExecutionDependencies } from '../src/run/execute/types.js'

export type SeedScope = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  userId: string
}

export type SeededRun = {
  messageId: string
  payload: RunExecuteJobPayload
  runId: string
  taskId: string
  threadId: string
}

// One isolated organization per harness invocation so seeded rows never
// collide with (or leak into) real team data.
export const seedScope = async (
  prisma: PrismaClient,
  label: string,
): Promise<SeedScope> => {
  const suffix = randomUUID().slice(0, 8)
  const organization = await prisma.organization.create({
    data: { name: `mock-llm-${label}-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `mock-llm-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `mock-llm-team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `mock-llm-${label}-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `mock-llm-${label}-${suffix}`,
      teamId: team.id,
    },
  })
  const user = await prisma.user.create({
    data: { displayName: `Mock LLM ${suffix}`, email: `mock-llm-${suffix}@example.com` },
  })
  const agent = await prisma.agent.create({
    data: {
      model: 'mock-model',
      name: `mock-llm-agent-${suffix}`,
      organizationId: organization.id,
      provider: 'openai',
      systemPrompt: 'You are a deterministic smoke-test assistant. Keep answers short.',
    },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    userId: user.id,
  }
}

export const seedRun = async (
  prisma: PrismaClient,
  scope: SeedScope,
  messageContent: string,
): Promise<SeededRun> => {
  const thread = await prisma.thread.create({ data: { channelId: scope.channelId } })
  const run = await prisma.run.create({
    data: { agentId: scope.agentId, threadId: thread.id },
  })
  const task = await prisma.task.create({
    data: {
      agentId: scope.agentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      runId: run.id,
      title: `mock-llm run ${run.id.slice(0, 8)}`,
    },
  })
  const message = await prisma.message.create({
    data: {
      content: messageContent,
      role: 'user',
      threadId: thread.id,
      userId: scope.userId,
    },
  })

  const payload = RunExecuteJobPayloadSchema.parse({
    actorContext: {
      actor: { actorId: scope.userId, actorType: 'user', roles: ['owner'] },
      actionContext: {
        agentId: scope.agentId,
        channelId: scope.channelId,
        correlationId: randomUUID(),
        effectiveUserId: scope.userId,
        requestId: randomUUID(),
        taskId: task.id,
        teamId: scope.teamId,
        threadId: thread.id,
      },
      tenant: {
        channelId: scope.channelId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        teamId: scope.teamId,
      },
    },
    agentId: scope.agentId,
    interactive: true,
    messageId: message.id,
    runId: run.id,
    taskId: task.id,
    threadId: thread.id,
  })

  return {
    messageId: message.id,
    payload,
    runId: run.id,
    taskId: task.id,
    threadId: thread.id,
  }
}

const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type MockPipeline = {
  /**
   * The same dependency bundle the subscribers hand `executeRunJob`. Exposed
   * for suites that drive the handler themselves — the crash/resume tests need
   * to control when an execution stops, which a queue subscriber cannot give
   * them.
   */
  deps: ExecutionDependencies
  enqueueRun: (payload: RunExecuteJobPayload) => Promise<void>
  pool: ReturnType<typeof createPgPool>
  prisma: PrismaClient
  queueProvider: PgQueueProvider
  stop: () => Promise<void>
  waitForTerminalRuns: (
    runIds: string[],
    timeoutMs?: number,
  ) => Promise<Map<string, string>>
}

// Real end-to-end pipeline: PgQueueProvider + PgRealtimeTransport + the real
// executeRunJob handler, with only inference pointed at the mock provider
// (NESSIE_MODEL_BASE_URL). `workers` spins up that many independent queue
// subscribers — the same table-claim loop separate worker replicas run — so
// the load mode exposes queue-claim and row-lock contention.
export const startMockPipeline = async (
  input: { workers?: number } = {},
): Promise<MockPipeline> => {
  const config = loadConfig()
  const databaseUrl = process.env.DATABASE_URL ?? config.database.url
  const pool = createPgPool(databaseUrl, { max: config.database.poolMax, min: 0 })
  const prisma = getPrismaClient({ connectionLimit: config.database.poolMax })
  const queueProvider = new PgQueueProvider(pool)
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl)
  const modelClient = createModelClient(config.model, {
    systemComponent: 'mock-llm-harness',
  })

  const deps: ExecutionDependencies = {
    modelClient,
    prisma,
    queueProvider,
    realtimeTransport,
    searchConfig: { modelClient, pool },
  }

  const abort = new AbortController()
  // Zero is legitimate: a suite that drives `executeRunJob` itself wants the
  // pipeline's wiring without a subscriber racing it for the same job.
  const workers = Math.max(0, input.workers ?? 1)
  for (let index = 0; index < workers; index += 1) {
    queueProvider.subscribe(
      'run.execute',
      async (job, { signal }) => {
        const payload = RunExecuteJobPayloadSchema.parse(job.payload)
        await executeRunJob(
          deps,
          payload,
          { attempt: job.attempt, maxAttempts: job.maxAttempts },
          { signal },
        )
      },
      { pollIntervalMs: 25, signal: abort.signal },
    )
  }

  return {
    deps,
    enqueueRun: async (payload) => {
      await enqueueQueueJob(prisma, { payload, topic: 'run.execute' })
    },
    pool,
    prisma,
    queueProvider,
    stop: async () => {
      abort.abort()
      modelClient.close()
      await realtimeTransport.close()
      await pool.end()
      await disconnectPrismaClient()
    },
    waitForTerminalRuns: async (runIds, timeoutMs = 60_000) => {
      const terminal = new Map<string, string>()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const runs = await prisma.run.findMany({
          select: { id: true, status: true },
          where: { id: { in: runIds } },
        })
        for (const run of runs) {
          if (TERMINAL_STATUSES.has(run.status)) {
            terminal.set(run.id, run.status)
          }
        }
        if (terminal.size === runIds.length) {
          return terminal
        }
        await sleep(100)
      }
      const missing = runIds.filter((id) => !terminal.has(id))
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${missing.length} run(s): ${missing.join(', ')}`,
      )
    },
  }
}

// Remove only the rows this harness created. Queue jobs are raw-SQL rows
// carrying the run id in their payload; everything else is either deleted
// explicitly (ledger events have no org FK) or cascades from the organization.
export const cleanupScope = async (
  prisma: PrismaClient,
  pool: ReturnType<typeof createPgPool>,
  scope: SeedScope,
  runIds: string[],
): Promise<void> => {
  if (runIds.length > 0) {
    await pool.query(`DELETE FROM queue_jobs WHERE payload->>'runId' = ANY($1::text[])`, [runIds])
  }
  await prisma.tokenLedgerEvent.deleteMany({
    where: { organizationId: scope.organizationId },
  })
  try {
    await prisma.organization.delete({ where: { id: scope.organizationId } })
  } catch (error) {
    console.warn(
      '[mock-llm harness] organization cleanup incomplete (leftover seeded rows are namespaced and harmless):',
      error instanceof Error ? error.message : error,
    )
  }
  await prisma.user.delete({ where: { id: scope.userId } }).catch(() => undefined)
}
