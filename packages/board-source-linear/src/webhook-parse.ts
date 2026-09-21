import type { WebhookDelivery, WebhookRequest } from '@nessie/board-sources'

type LinearWebhookPayload = {
  action?: string
  type?: string
  data?: {
    id?: string
    team?: { id?: string }
    teamId?: string | null
    issueId?: string
    issue?: { id?: string; teamId?: string; team?: { id?: string } }
  }
  webhookId?: string
  webhookTimestamp?: number
}

/**
 * One delivery, by resource type.
 *
 * - `Issue`: the issue's id, re-read by the processor.
 * - `Comment`: the *issue's* id — the processor re-reads the issue with its
 *   comments — plus, on `remove`, the deleted comment's id, because polling
 *   can never see a deletion.
 * - `IssueLabel`: no ids, `resource: 'label'`; the processor re-describes the
 *   container so a rename or recolour upstream reaches every pill.
 */
export const parseLinearWebhook = (request: WebhookRequest): WebhookDelivery => {
  const parsed = JSON.parse(request.rawBody) as LinearWebhookPayload
  const id = parsed.data?.id
  // Linear has no delivery header; the payload names the webhook and the
  // moment it fired, and a redelivery repeats both byte for byte. Without
  // `webhookId` there is nothing provider-supplied to key on, so the caller
  // hashes the body instead of keying on a partly-invented string.
  const deliveryId = parsed.webhookId
    ? `${parsed.webhookId}:${id ?? 'none'}:${parsed.webhookTimestamp ?? 0}`
    : null

  if (parsed.type === 'IssueLabel') {
    return {
      deliveryId,
      // A workspace label has no team; every Linear source is then a
      // candidate and each re-describes its own team.
      containerKey: parsed.data?.teamId ?? parsed.data?.team?.id ?? null,
      externalIds: [],
      resource: 'label',
    }
  }

  if (parsed.type === 'Comment') {
    const issueId = parsed.data?.issueId ?? parsed.data?.issue?.id
    return {
      deliveryId,
      containerKey: parsed.data?.issue?.teamId ?? parsed.data?.issue?.team?.id ?? null,
      externalIds: issueId ? [issueId] : [],
      resource: 'item',
      ...(parsed.action === 'remove' && id ? { removedCommentExternalIds: [id] } : {}),
    }
  }

  return {
    deliveryId,
    containerKey: parsed.data?.team?.id ?? parsed.data?.teamId ?? null,
    externalIds: id ? [id] : [],
    resource: 'item',
  }
}

