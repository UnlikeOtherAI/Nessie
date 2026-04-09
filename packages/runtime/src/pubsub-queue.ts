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
  private readonly processedIds = new Set<string>()

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

    if (this.processedIds.has(job.id)) {
      return
    }

    const handler = this.handlers.get(job.topic)
    if (!handler) {
      throw new Error(`No handler registered for topic: ${job.topic}`)
    }

    try {
      this.processedIds.add(job.id)
      await handler(job)

      // Evict old IDs to prevent unbounded memory growth.
      // Keep the most recent entries for dedup window.
      if (this.processedIds.size > 10_000) {
        const entries = Array.from(this.processedIds)
        for (let i = 0; i < 5_000; i++) {
          this.processedIds.delete(entries[i]!)
        }
      }
    } catch (error) {
      this.processedIds.delete(job.id)
      throw error
    }
  }
}

export { decodePushMessage }
export type { PubSubClient, PubSubQueueOptions, PubSubTopic, PushMessage }
