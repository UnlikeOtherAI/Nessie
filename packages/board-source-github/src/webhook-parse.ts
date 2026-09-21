import type { WebhookDelivery, WebhookRequest } from '@nessie/board-sources'

type GitHubWebhookPayload = {
  action?: string
  issue?: { number?: number; node_id?: string }
  comment?: { id?: number }
  label?: { id?: number }
  projects_v2_item?: { node_id?: string }
  repository?: { full_name?: string }
}

/**
 * One delivery, by event (`x-github-event`).
 *
 * - `issues`: the issue's number, re-read by the processor (the issue endpoint
 *   is addressed by number, so that is what is carried).
 * - `issue_comment`: the *issue's* number — the re-read brings its comments —
 *   plus, on `deleted`, the comment's id, because polling can never see a
 *   deletion.
 * - `label`: no ids, `resource: 'label'`; the processor re-describes the
 *   repository so a rename or recolour reaches every pill.
 */
export const parseGitHubWebhook = (request: WebhookRequest): WebhookDelivery => {
  const parsed = JSON.parse(request.rawBody) as GitHubWebhookPayload
  const event = request.headers['x-github-event']
  // GitHub's own delivery uuid, identical across every redelivery of the same
  // event. Null rather than a clock reading when it is absent: the caller
  // hashes the body, which at least dedupes a retry.
  const deliveryId = request.headers['x-github-delivery'] ?? null
  const containerKey = parsed.repository?.full_name ? `repo:${parsed.repository.full_name}` : null

  if (event === 'label' || (!event && parsed.label && !parsed.issue)) {
    return { deliveryId, containerKey, externalIds: [], resource: 'label' }
  }

  const issueNumber = parsed.issue?.number
  const externalIds = issueNumber ? [String(issueNumber)] : []
  if (event === 'issue_comment' || (!event && parsed.comment)) {
    const commentId = parsed.comment?.id
    return {
      deliveryId,
      containerKey,
      externalIds,
      resource: 'item',
      ...(parsed.action === 'deleted' && commentId
        ? { removedCommentExternalIds: [String(commentId)] }
        : {}),
    }
  }

  return { deliveryId, containerKey, externalIds, resource: 'item' }
}
