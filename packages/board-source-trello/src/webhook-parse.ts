import type { WebhookDelivery, WebhookRequest } from '@nessie/board-sources'

type TrelloWebhookPayload = {
  action?: {
    id?: string
    type?: string
    data?: {
      card?: { id?: string }
      board?: { id?: string }
      /** On `deleteComment` / `updateComment`: the comment action itself. */
      action?: { id?: string }
    }
  }
}

/** Actions on the board's labels themselves, rather than on a card's set. */
const LABEL_ACTIONS = new Set(['createLabel', 'updateLabel', 'deleteLabel'])

/**
 * One delivery, by action type. A card action names its card, which the
 * processor re-reads with its comments; `deleteComment` also names the deleted
 * comment, because polling can never see a deletion; a label action re-describes
 * the board so a rename or recolour reaches every pill.
 */
export const parseTrelloWebhook = (request: WebhookRequest): WebhookDelivery => {
  const parsed = JSON.parse(request.rawBody) as TrelloWebhookPayload
  const action = parsed.action
  // Trello identifies the action, not the delivery, and repeats that id on
  // every retry of it. Null rather than a clock reading when the payload
  // carries none — the caller hashes the body instead.
  const deliveryId = action?.id ?? null
  const containerKey = action?.data?.board?.id ?? null

  if (action?.type && LABEL_ACTIONS.has(action.type)) {
    return { deliveryId, containerKey, externalIds: [], resource: 'label' }
  }
  const cardId = action?.data?.card?.id
  const removed = action?.type === 'deleteComment' ? action.data?.action?.id : undefined
  return {
    deliveryId,
    containerKey,
    externalIds: cardId ? [cardId] : [],
    resource: 'item',
    ...(removed ? { removedCommentExternalIds: [removed] } : {}),
  }
}
