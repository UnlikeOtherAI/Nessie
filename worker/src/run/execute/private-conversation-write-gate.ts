import type { RunContext } from './types.js'

// These durable surfaces have no disclosure basis or original-author grant
// protocol. Chat delivery and handoff implement their own destination-aware
// handling, so they are deliberately absent.
const UNSCOPED_CONTENT_SINKS = new Set([
  'kb_comment_add',
  'kb_comment_reply',
  'kb_document_edit',
  'kb_draft_write',
  'kb_note_add',
  'mailbox_send',
  'ticket_create',
  'ticket_update',
  'workflow_create',
  'workflow_update',
])

/**
 * An MCP or executor call has arbitrary third-party side effects, and these
 * builtin writes do not carry a disclosure basis. A private transcript source
 * therefore closes them for a shared agent until that surface gains a scoped
 * author-consent flow. External MCP/executor writes remain unbounded for every
 * agent, so they always close.
 */
export const blocksPrivateConversationWrite = (input: {
  context: RunContext
  isExternal: boolean
  toolName: string
}): boolean =>
  input.context.consumedSources.privateConversationSources().length > 0
  && (
    input.isExternal
    || (
      input.context.agent.agentKind === 'shared'
      && UNSCOPED_CONTENT_SINKS.has(input.toolName)
    )
  )
