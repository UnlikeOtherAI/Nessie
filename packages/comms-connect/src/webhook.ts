/**
 * A raw inbound webhook delivery handed to a connector's `processWebhook`.
 * Headers are lower-cased by convention so signature/validation lookups are
 * stable across HTTP frameworks. `rawBody` (the exact bytes as a string) is
 * kept alongside the parsed `body` because most providers sign the raw
 * payload.
 */
export type WebhookRequest = {
  headers: Record<string, string>
  query?: Record<string, string>
  body: unknown
  rawBody?: string
}
