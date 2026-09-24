import { verifyHmacSignature } from '@nessie/runtime'
import {
  DEEP_WATER_EVENT_MAX_SKEW_MS,
  DEEP_WATER_EVENT_SIGNATURE_PREFIX,
  DeepWaterResearchEventSchema,
  type DeepWaterResearchEvent,
} from '@nessie/schemas'

/**
 * Authenticating one research event DeepWater pushed to Nessie (Water plan
 * amendments-streaming S2). The key is `DEEPWATER_EVENTS_SECRET` — DeepWater
 * holds the same value as `NESSIE_EVENTS_SIGNING_SECRET` — installed on deploy
 * from the GitHub Actions secret of the same name. Unset, the receiver answers
 * 503 and DeepWater keeps retrying, while the watch through Ledger serves on
 * its own.
 *
 * Pure: the route supplies the request's bytes, headers and clock, so the
 * published HMAC test vector can be checked at the instant it was signed.
 */

export const DEEP_WATER_EVENTS_SECRET_ENV = 'DEEPWATER_EVENTS_SECRET'

/** DeepWater's own floor for the key (Water refuses to push with a shorter one). */
export const DEEP_WATER_EVENTS_SECRET_MIN_LENGTH = 32

/**
 * The receiver's key, or null when the receiver is not configured. A key
 * shorter than DeepWater's floor is refused rather than used: it cannot be the
 * key DeepWater signs with, so every event would fail its signature anyway.
 */
export const readDeepWaterEventsSecret = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const value = env[DEEP_WATER_EVENTS_SECRET_ENV]?.trim() ?? ''
  if (value.length === 0) return null
  if (value.length < DEEP_WATER_EVENTS_SECRET_MIN_LENGTH) {
    console.error(
      `[deep-water] ${DEEP_WATER_EVENTS_SECRET_ENV} is shorter than ${DEEP_WATER_EVENTS_SECRET_MIN_LENGTH} characters; `
      + 'the research event receiver is off until it is replaced',
    )
    return null
  }
  return value
}

export type DeepWaterEventRejection = {
  status: 400 | 401
  code: 'DEEP_WATER_EVENT_SIGNATURE_INVALID' | 'DEEP_WATER_EVENT_STALE' | 'DEEP_WATER_EVENT_MALFORMED'
  message: string
  details?: unknown
}

export type DeepWaterEventAuthentication =
  | { ok: true; event: DeepWaterResearchEvent }
  | ({ ok: false } & DeepWaterEventRejection)

/**
 * Check, in order: the signature over the exact bytes received (constant
 * time, `sha256=` prefix required), the body against the v1 contract, the
 * event id header against the body, and `sent_at` within ten minutes of now
 * either way. DeepWater re-signs every delivery attempt with a fresh
 * `sent_at`, so a stale one is a replay or a skewed clock — refused as 401,
 * which DeepWater retries, as it does a signature that does not match (the
 * key was rotated on one side only). A body outside the contract is 400,
 * which DeepWater drops and logs: sending it again would not change it.
 */
export const authenticateDeepWaterEvent = (input: {
  secret: string
  rawBody: Buffer | undefined
  signature: string | null
  eventIdHeader: string | null
  body: unknown
  now: Date
}): DeepWaterEventAuthentication => {
  const signed = input.rawBody !== undefined
    && input.signature !== null
    && input.signature.startsWith(DEEP_WATER_EVENT_SIGNATURE_PREFIX)
    && verifyHmacSignature({
      encoding: 'hex',
      payload: input.rawBody,
      prefix: DEEP_WATER_EVENT_SIGNATURE_PREFIX,
      secret: input.secret,
      signature: input.signature,
    })
  if (!signed) {
    return {
      ok: false,
      status: 401,
      code: 'DEEP_WATER_EVENT_SIGNATURE_INVALID',
      message: 'The research event is not signed with this deployment\'s key.',
    }
  }
  const parsed = DeepWaterResearchEventSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: 'DEEP_WATER_EVENT_MALFORMED',
      message: 'The research event is outside the deepwater.research-event.v1 contract.',
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }
  }
  const event = parsed.data
  if (input.eventIdHeader !== event.event_id) {
    return {
      ok: false,
      status: 400,
      code: 'DEEP_WATER_EVENT_MALFORMED',
      message: 'The event id header does not name the event in the body.',
    }
  }
  if (Math.abs(input.now.getTime() - Date.parse(event.sent_at)) > DEEP_WATER_EVENT_MAX_SKEW_MS) {
    return {
      ok: false,
      status: 401,
      code: 'DEEP_WATER_EVENT_STALE',
      message: 'The research event was not sent within ten minutes of now.',
    }
  }
  return { ok: true, event }
}
