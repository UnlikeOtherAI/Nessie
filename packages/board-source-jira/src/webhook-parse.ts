import type { WebhookDelivery, WebhookRequest } from '@nessie/board-sources'

type JiraWebhookPayload = {
  timestamp?: number
  webhookEvent?: string
  issue?: { id?: string; fields?: { project?: { id?: string; key?: string } } }
  comment?: { id?: string }
}

/**
 * One delivery. An issue event names its issue; a comment event names the
 * *issue* too — the processor re-reads it with its comments — and
 * `comment_deleted` also names the comment, because polling can never see a
 * deletion.
 */
export const parseJiraWebhook = (request: WebhookRequest): WebhookDelivery => {
  const parsed = JSON.parse(request.rawBody) as JiraWebhookPayload
  const removed =
    parsed.webhookEvent === 'comment_deleted' && parsed.comment?.id ? [parsed.comment.id] : null
  return {
    // Jira sends no delivery id at all — `issue.id` plus `timestamp` is a
    // composite we invented, and two events on one issue in the same
    // millisecond share it. Null, so the caller keys on the body hash, which
    // separates those two and still collapses a redelivery.
    deliveryId: null,
    // The delivery names the project, not the site, so the source is found by
    // its token rather than by a container key.
    containerKey: null,
    externalIds: parsed.issue?.id ? [parsed.issue.id] : [],
    resource: 'item',
    ...(removed ? { removedCommentExternalIds: removed } : {}),
  }
}
