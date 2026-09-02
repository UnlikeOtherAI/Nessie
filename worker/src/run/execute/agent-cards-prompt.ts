import { CARD_POST_TOOL_ID } from '@nessie/runtime'

/**
 * The one line that tells an agent it can post cards.
 *
 * Structural, from toolset facts only: it appears exactly when `card_post` is
 * in the run's resolved builtin ids, so an agent whose `toolPolicy` disables
 * the tool is never told about a capability its toolset withholds. It never
 * reads message content.
 */
export const hasCardPromptTools = (toolIds: ReadonlySet<string>): boolean =>
  toolIds.has(CARD_POST_TOOL_ID)

export const buildAgentCardsBlock = (facts: { hasCardTool: boolean }): string | null => {
  if (!facts.hasCardTool) return null
  return (
    'You can post an interactive card into this conversation with `card_post` '
    + '(a ticket or email overview, an image with a caption, a small form) whose buttons the '
    + 'person presses, and the press and any entered values come back to you and stay in the '
    + 'conversation — prefer it over prose whenever you need a decision, a confirmation, a '
    + 'secret, or structured input.'
  )
}
