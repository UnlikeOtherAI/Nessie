import { randomUUID } from 'node:crypto'
import type { QueueHandler, QueueJob, QueueProvider } from './queue.js'

type PubSubClient = {
  topic(name: string): PubSubTopic
}

type PubSubTopic = {
  publishMessage(message: {
    data: Buffer
    attributes?: Record<string, string>
    orderingKey?: string
  }): Promise<string>
}

type PubSubQueueOptions = {
  projectId: string
  maxDeliveryAttempts?: number
}

type PushMessage = {
  message: {
    attributes?: Record<string, string>
    data: string
    messageId: string
    publishTime: string
  }
  subscription: string
}

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5
const PROCESSED_IDS_CAP = 10_000
const PROCESSED_IDS_EVICT_BATCH = 5_000

const logPubSubError = (message: string, error: unknown): void => {
  console.error(message, error)
}

const decodePushMessage = (raw: PushMessage): QueueJob | null => {
  try {
    const decoded = Buffer.from(raw.message.data, 'base64').toString('utf8')
    const payload = JSON.parse(decoded) as unknown
    const topic = raw.message.attributes?.['topic'] ?? raw.subscription

    return {
      id: raw.message.messageId,
      topic,
      payload,
      attempt: Number(raw.message.attributes?.['attempt'] ?? '1'),
      maxAttempts: Number(
        raw.message.attributes?.['maxAttempts'] ?? String(DEFAULT_MAX_DELIVERY_ATTEMPTS),
      ),
      enqueuedAt: raw.message.publishTime,
    }
  } catch (error) {
    logPubSubError('Failed to decode Pub/Sub push message', error)
    return null
  }
}

export class PubSubQueueProvider implements QueueProvider {
  private readonly client: PubSubClient
  private readonly projectId: string
  private readonly maxDeliveryAttempts: number
  private readonly handlers = new Map<string, QueueHandler>()
  // Bounded FIFO of completed message IDs. Map preserves insertion order, so
  // the oldest entry is always the first key — cheap eviction without a
  // parallel array, and no snapshot races.
  private readonly processedIds = new Map<string, true>()
  // IDs currently being handled. Used to drop true duplicates that arrive
  // while the handler is awaiting, without committing them as "processed"
  // before the handler resolves successfully.
  private readonly inFlightIds = new Set<string>()

  constructor(client: PubSubClient, options: PubSubQueueOptions) {
    this.client = client
    this.projectId = options.projectId
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS
  }

  async enqueue(
    topic: string,
    payload: unknown,
    options: { delayMs?: number; idempotencyKey?: string; orderingKey?: string } = {},
  ): Promise<string> {
    const messageId = options.idempotencyKey ?? randomUUID()
    const data = Buffer.from(JSON.stringify(payload))

    const attributes: Record<string, string> = {
      topic,
      maxAttempts: String(this.maxDeliveryAttempts),
      attempt: '1',
    }

    if (options.idempotencyKey) {
      attributes['idempotencyKey'] = options.idempotencyKey
    }

    const topicRef = this.client.topic(
      `projects/${this.projectId}/topics/${topic}`,
    )

    const publishedId = await topicRef.publishMessage({
      data,
      attributes,
      orderingKey: options.orderingKey,
    })

    if (options.delayMs) {
      console.warn(
        `PubSub does not natively support delayed messages. ` +
        `Message ${publishedId} published immediately to ${topic}.`,
      )
    }

    return publishedId ?? messageId
  }

  async acknowledge(_jobId: string): Promise<void> {
    // In push mode, returning 2xx from the HTTP handler acknowledges the message.
    // This method exists for interface compatibility.
  }

  async nack(_jobId: string, _reason?: string): Promise<void> {
    // In push mode, returning a non-2xx status from the HTTP handler nacks the message.
    // Pub/Sub will redeliver based on the subscription's retry policy.
  }

  subscribe(
    topic: string,
    handler: QueueHandler,
    _options?: { pollIntervalMs?: number; signal?: AbortSignal },
  ): void {
    this.handlers.set(topic, handler)
  }

  async handlePushMessage(raw: PushMessage): Promise<void> {
    const job = decodePushMessage(raw)
    if (!job) {
      return
    }

    if (this.processedIds.has(job.id) || this.inFlightIds.has(job.id)) {
      return
    }

    const handler = this.handlers.get(job.topic)
    if (!handler) {
      throw new Error(`No handler registered for topic: ${job.topic}`)
    }

    this.inFlightIds.add(job.id)
    try {
      await handler(job)
      // Only commit to processedIds after the handler resolves successfully,
      // so a thrown handler does not silently swallow concurrent redeliveries.
      this.processedIds.set(job.id, true)

      // Evict oldest IDs in batches to keep memory bounded. Map iteration is
      // insertion-ordered, so the first keys are the oldest entries.
      if (this.processedIds.size > PROCESSED_IDS_CAP) {
        const iterator = this.processedIds.keys()
        for (let i = 0; i < PROCESSED_IDS_EVICT_BATCH; i++) {
          const next = iterator.next()
          if (next.done) {
            break
          }
          this.processedIds.delete(next.value)
        }
      }
    } finally {
      this.inFlightIds.delete(job.id)
    }
  }
}

export { decodePushMessage }
export type { PubSubClient, PubSubQueueOptions, PubSubTopic, PushMessage }
