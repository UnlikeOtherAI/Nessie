import { pathToFileURL } from 'node:url'
import { deriveRuntimeCapabilities, loadConfig } from '@nessie/config'
import {
  createModelClient,
  createPgPool,
  PgQueueProvider,
  PgRealtimeTransport,
} from '@nessie/runtime'
import {
  ExecutionEnvironmentAllocateJobPayloadSchema,
  RunExecuteJobPayloadSchema,
  TriggerEventDispatchJobPayloadSchema,
  WorkflowRunExecuteJobPayloadSchema,
} from '@nessie/schemas'
import { getPrismaClient } from './db/client.js'
import { allocateExecutionEnvironmentInstance, registerExecutionRunners } from './control/execution.js'
import { dispatchNextMailboxMessage, reclaimExpiredMailboxMessages } from './control/mailbox.js'
import { dispatchEventTriggers, sweepDueScheduledTriggers } from './control/triggers.js'
import { executeWorkflowRun } from './control/workflows.js'
import { executeRunJob } from './run/execute.js'

const config = loadConfig()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = config.database.url
}
const databaseUrl = process.env.DATABASE_URL

const prisma = getPrismaClient()

export const startWorker = async (): Promise<{ stop: () => Promise<void> }> => {
  const pool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })

  // Queue provider is config-switchable (prereq #12)
  let queueProvider: PgQueueProvider
  if (config.queue.provider === 'pubsub') {
    console.warn('[worker] Pub/Sub queue provider configured but not yet available — using PgQueueProvider')
  }
  queueProvider = new PgQueueProvider(pool)
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl)
  const modelClient = createModelClient(config.model)
  const abortController = new AbortController()

  queueProvider.subscribe(
    'run.execute',
    async (job) => {
      const payload = RunExecuteJobPayloadSchema.parse(job.payload)
      await executeRunJob(
        {
          modelClient,
          prisma,
          queueProvider,
          realtimeTransport,
          searchConfig: {
            modelClient,
            pool,
          },
        },
        payload,
      )
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    'trigger.event.dispatch',
    async (job) => {
      const payload = TriggerEventDispatchJobPayloadSchema.parse(job.payload)
      await dispatchEventTriggers(prisma, payload)
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    'workflow.run.execute',
    async (job) => {
      const payload = WorkflowRunExecuteJobPayloadSchema.parse(job.payload)
      await executeWorkflowRun(prisma, payload.workflowRunId)
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    'execution.environment.allocate',
    async (job) => {
      const payload = ExecutionEnvironmentAllocateJobPayloadSchema.parse(job.payload)
      await allocateExecutionEnvironmentInstance(prisma, payload.instanceId)
    },
    {
      signal: abortController.signal,
    },
  )

  const runnerLabelPrefix = `${process.env.HOSTNAME ?? 'local-worker'}`
  await registerExecutionRunners(prisma, {
    labelPrefix: runnerLabelPrefix,
  })

  let triggerSweepInFlight = false
  const triggerSweepInterval = setInterval(async () => {
    if (triggerSweepInFlight || abortController.signal.aborted) {
      return
    }

    triggerSweepInFlight = true
    try {
      await sweepDueScheduledTriggers(prisma, {
        limit: 20,
      })
    } catch (error) {
      console.error('[worker.trigger-sweep] failed', error)
    } finally {
      triggerSweepInFlight = false
    }
  }, 15_000)

  let mailboxSweepInFlight = false
  const mailboxSweepInterval = setInterval(async () => {
    if (mailboxSweepInFlight || abortController.signal.aborted) {
      return
    }

    mailboxSweepInFlight = true
    try {
      await reclaimExpiredMailboxMessages(prisma)

      let dispatched = true
      let iterations = 0
      while (dispatched && iterations < 10) {
        dispatched = await dispatchNextMailboxMessage(prisma, realtimeTransport)
        iterations += 1
      }
    } catch (error) {
      console.error('[worker.mailbox-sweep] failed', error)
    } finally {
      mailboxSweepInFlight = false
    }
  }, 5_000)

  const runnerHeartbeatInterval = setInterval(async () => {
    if (abortController.signal.aborted) {
      return
    }

    try {
      await registerExecutionRunners(prisma, {
        labelPrefix: runnerLabelPrefix,
      })
    } catch (error) {
      console.error('[worker.execution-runners] heartbeat failed', error)
    }
  }, 30_000)

  console.log(
    JSON.stringify(
      {
        service: 'worker',
        mode: config.mode,
        capabilities: deriveRuntimeCapabilities(config),
        queueProvider: config.queue.provider,
        status: 'ready',
      },
      null,
      2,
    ),
  )

  const stop = async () => {
    abortController.abort()
    clearInterval(triggerSweepInterval)
    clearInterval(mailboxSweepInterval)
    clearInterval(runnerHeartbeatInterval)
    modelClient.close()
    await realtimeTransport.close()
    await pool.end()
    await prisma.$disconnect()
  }

  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0))
  })

  return { stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startWorker()
}
