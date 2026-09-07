import {
  BROWSER_ACT_TOOL_ID,
  BROWSER_OPEN_TOOL_ID,
  EMAIL_SEND_TOOL_ID,
} from '@nessie/runtime'

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
  // A private source can be placed in a URL or typed into an external page.
  // Neither browser verb has an original-author-bound disclosure protocol.
  BROWSER_ACT_TOOL_ID,
  BROWSER_OPEN_TOOL_ID,
  EMAIL_SEND_TOOL_ID,
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
 * author-consent flow. This boundary is deliberately for shared agents: a
 * person's PA continues using that person's private integrations in its own
 * conversation, whose ordinary reply stays destination-contained.
 */
export const blocksPrivateConversationWrite = (input: {
  context: RunContext
  isExternal: boolean
  toolName: string
}): boolean =>
  input.context.consumedSources.privateConversationSources().length > 0
  && input.context.agent.agentKind === 'shared'
  && (
    input.isExternal
    || UNSCOPED_CONTENT_SINKS.has(input.toolName)
  )
