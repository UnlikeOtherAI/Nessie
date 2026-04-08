import { pathToFileURL } from 'node:url'
import { deriveRuntimeCapabilities, loadConfig } from '@nessie/config'
import {
  createModelClient,
  createPgPool,
  PgQueueProvider,
  PgRealtimeTransport,
} from '@nessie/runtime'
import { RunExecuteJobPayloadSchema } from '@nessie/schemas'
import { getPrismaClient } from './db/client.js'
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
  const queueProvider = new PgQueueProvider(pool)
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl)
  const modelClient = createModelClient(config.model)
  const embeddingApiKey =
    process.env.OPENAI_API_KEY ??
    process.env.OPENAI_CHAT_API_KEY ??
    config.model.apiKey ??
    ''
  if (!embeddingApiKey) {
    console.warn('No embedding API key configured — worker memory retrieval will fail')
  }
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
            embedding: { apiKey: embeddingApiKey },
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
