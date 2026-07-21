import type {
  NormalizedEvent,
  WebhookRequest,
} from '@nessie/comms-connect'

import { convTypeFromChannelType, normalizeSlackMessage } from './normalize.js'
import { verifySlackSignature } from './signature.js'
import type { SlackMessage, SlackWebhookOutcome } from './types.js'

type SlackEvent = SlackMessage & {
  channel?: string
  channel_type?: string
  deleted_ts?: string
  message?: SlackMessage
  previous_message?: SlackMessage
}

type SlackEnvelope = {
  type?: string
  challenge?: string
  team_id?: string
  event_id?: string
  event?: SlackEvent
}

const parseEnvelope = (request: WebhookRequest): SlackEnvelope => {
  if (request.rawBody) {
    return JSON.parse(request.rawBody) as SlackEnvelope
  }
  return (request.body ?? {}) as SlackEnvelope
}

/**
 * Turn one Events API `message` event into normalized events. Handles the plain
 * message, the `message_changed` edit (new version + `editedAt`), and the
 * `message_deleted` tombstone (`isDeleted`). Other subtypes (joins, topic
 * changes, bot noise) are ignored.
 */
const normalizeEvent = (
  envelope: SlackEnvelope,
): NormalizedEvent[] => {
  const event = envelope.event
  const teamId = envelope.team_id
  if (!event || event.type !== 'message' || !teamId || !event.channel) {
    return []
  }
  const convType = convTypeFromChannelType(event.channel_type)
  const base = {
    teamId,
    channelId: event.channel,
    convType,
  }

  if (event.subtype === 'message_deleted') {
    if (!event.deleted_ts) {
      return []
    }
    return [
      normalizeSlackMessage({
        ...base,
        message: event.previous_message ?? {},
        messageTs: event.deleted_ts,
        isDeleted: true,
      }),
    ]
  }

  if (event.subtype === 'message_changed') {
    const changed = event.message
    if (!changed?.ts) {
      return []
    }
    return [normalizeSlackMessage({ ...base, message: changed })]
  }

  if (event.subtype !== undefined || !event.ts) {
    return [] // Non-message subtype (join/topic/bot) — not an authored message.
  }
  return [normalizeSlackMessage({ ...base, message: event })]
}

/**
 * Verify and classify one Slack webhook delivery. Returns the discriminated
 * {@link SlackWebhookOutcome} so the API layer can answer a `url_verification`
 * challenge, ingest `message` events, or drop an unrelated callback — all after
 * the `v0` signature + freshness check has passed. Throws
 * `SlackSignatureError` when verification fails.
 */
export const inspectSlackWebhook = (
  request: WebhookRequest,
  signingSecret: string,
  nowMs: number,
): SlackWebhookOutcome => {
  verifySlackSignature({
    signingSecret,
    signature: request.headers['x-slack-signature'],
    timestamp: request.headers['x-slack-request-timestamp'],
    rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
    nowMs,
  })

  const envelope = parseEnvelope(request)
  if (envelope.type === 'url_verification') {
    return { kind: 'challenge', challenge: envelope.challenge ?? '' }
  }
  if (envelope.type !== 'event_callback') {
    return { kind: 'ignored' }
  }
  const events = normalizeEvent(envelope)
  return events.length > 0 ? { kind: 'events', events } : { kind: 'ignored' }
}
