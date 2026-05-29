/**
 * src/agent/completion-delivery.ts — Direct media delivery for subagent completions.
 *
 * When a subagent task completes with generated media (image, music, video),
 * this module attempts to deliver the media directly to the target channel
 * instead of waking the requester agent and risking duplicate delivery.
 */

export interface TaskResult {
  taskId: string
  parentTaskId: string | null
  status: 'completed' | 'failed' | 'timeout'
  result: string
  duration: number
  toolCallCount: number
}

export interface DeliveryContext {
  targetChannel?: string
  targetUser?: string
}

export interface DeliveryAttempt {
  success: boolean
  idempotencyKey: string
  error?: string
}

// In-memory idempotency store: key → expiry timestamp
const deliveredKeys = new Map<string, number>()
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Generate an idempotency key for a delivery attempt.
 */
export function generateDeliveryIdempotencyKey(
  task: TaskResult,
  target: DeliveryContext,
  mediaHash: string,
): string {
  const targetKey = target.targetChannel ?? target.targetUser ?? 'unknown'
  return `${task.status}:${task.taskId}:${targetKey}:${mediaHash}`
}

/**
 * Check if a delivery was already attempted within the TTL.
 */
export function wasDelivered(key: string): boolean {
  cleanupExpired()
  return deliveredKeys.has(key)
}

/**
 * Mark a delivery as completed with a TTL.
 */
export function markDelivered(key: string, ttlMs = IDEMPOTENCY_TTL_MS): void {
  deliveredKeys.set(key, Date.now() + ttlMs)
}

/**
 * Clean up expired entries from the idempotency store.
 */
function cleanupExpired(): void {
  const now = Date.now()
  for (const [key, expiry] of deliveredKeys) {
    if (now > expiry) {
      deliveredKeys.delete(key)
    }
  }
}

/**
 * Extract media URLs from a task result string.
 * Looks for common media URL patterns (OpenClaw-managed media paths,
 * http/https URLs ending in image/video/audio extensions).
 */
export function extractMediaUrls(result: string): string[] {
  const urls: string[] = []

  // Match MEDIA paths (OpenClaw-managed)
  const mediaPaths = result.match(/MEDIA\/[^\s"')]+/g)
  if (mediaPaths) urls.push(...mediaPaths)

  // Match http/https URLs with media extensions
  const httpUrls = result.match(
    /https?:\/\/[^\s"')]+\.(?:png|jpg|jpeg|gif|webp|mp4|mov|mp3|wav|ogg|webm)/gi,
  )
  if (httpUrls) urls.push(...httpUrls)

  // Deduplicate
  return [...new Set(urls)]
}

/**
 * Generate a simple hash for media URLs.
 */
function hashMediaUrls(urls: string[]): string {
  return urls.sort().join('|').slice(0, 64)
}

/**
 * Attempt direct media delivery for a completed task.
 *
 * Returns { success: true } if:
 *   - No media URLs found (nothing to deliver)
 *   - Media was already delivered (idempotency)
 *   - Direct delivery succeeded
 *
 * Returns { success: false } if direct delivery failed and fallback is needed.
 */
export async function tryDirectMediaDelivery(
  task: TaskResult,
  target: DeliveryContext,
  deliverFn?: (urls: string[], target: DeliveryContext) => Promise<boolean>,
): Promise<DeliveryAttempt> {
  const mediaUrls = extractMediaUrls(task.result)

  // No media — nothing to deliver directly
  if (mediaUrls.length === 0) {
    return { success: true, idempotencyKey: '' }
  }

  const mediaHash = hashMediaUrls(mediaUrls)
  const idempotencyKey = generateDeliveryIdempotencyKey(task, target, mediaHash)

  // Already delivered within TTL
  if (wasDelivered(idempotencyKey)) {
    return { success: true, idempotencyKey }
  }

  // No delivery function provided — can't deliver directly
  if (!deliverFn) {
    return { success: false, idempotencyKey, error: 'No delivery function provided' }
  }

  try {
    const delivered = await deliverFn(mediaUrls, target)
    if (delivered) {
      markDelivered(idempotencyKey)
      return { success: true, idempotencyKey }
    }
    return { success: false, idempotencyKey, error: 'Delivery function returned false' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, idempotencyKey, error: msg }
  }
}

/**
 * Get a summary message for the requester after direct delivery.
 */
export function getDeliverySummary(task: TaskResult, mediaCount: number): string {
  const mediaLabel = mediaCount === 1 ? 'media item' : 'media items'
  return `Task ${task.taskId} completed. ${mediaCount} ${mediaLabel} delivered directly.`
}
