/**
 * The connection-watermark rule, horizontal-scaling invariant 9.
 *
 * Every durable realtime lane tracks, per connection, the highest id it has
 * written (`ThreadSseConnection.lastSequence`, `UserSseConnection.lastEventId`)
 * and refuses anything at or below it. That is only safe because the publisher
 * holds a per-scope advisory lock from before the INSERT until COMMIT
 * (`packages/runtime/src/realtime-publish.ts`), so inside the span a watermark
 * covers, id order *is* commit order and a genuinely new event always carries a
 * higher id. Without the lock, notifications arrive in commit order while ids
 * are handed out at insert time, the lower id is dropped for good, and the
 * client's `Last-Event-ID` has already moved past it so replay cannot return it
 * either — the defect this rule exists to make impossible.
 *
 * What can still repeat is the same event twice: a LISTEN reconnect, or an old
 * publisher mid rolling deploy. So the lane skips it, leaves the watermark
 * where it is — it is never advanced past an id that was not written — and
 * warns with both numbers, so a publisher regression is visible in the logs
 * rather than silently losing messages. Tracking every delivered id per
 * connection would buy nothing the lock does not already give, at unbounded
 * memory.
 */

// One `warn` call, so `app.log` fits and a test can record it.
export type RealtimeFanOutLogger = {
  warn: (details: Record<string, unknown>, message: string) => void
}

// The default keeps a hub built without a logger from swallowing the warning.
const defaultFanOutLogger: RealtimeFanOutLogger = {
  warn: (details, message) => console.warn(message, details),
}

const WATERMARK_DUPLICATE = 'realtime notification at or below the connection watermark; skipped'

export const createWatermarkDuplicateWarning = (
  logger: RealtimeFanOutLogger = defaultFanOutLogger,
) => (details: Record<string, unknown>): void => logger.warn(details, WATERMARK_DUPLICATE)
