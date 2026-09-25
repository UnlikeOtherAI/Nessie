import {
  BUILTIN_TOOL_DEFINITIONS,
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
  'kb_note_add',
  'kb_publish_request',
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

// A `safe` builtin only reads (`project_list` among the operator verbs).
const SAFE_BUILTIN_TOOL_IDS = new Set(BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.safe).map((tool) => tool.id))

/**
 * A standalone MCP call has arbitrary third-party side effects, and these
 * builtin writes do not carry a disclosure basis. A private transcript source
 * therefore closes them for a shared agent until that surface gains a scoped
 * author-consent flow. This boundary is deliberately for shared agents: a
 * person's PA continues using that person's private integrations in its own
 * conversation, whose ordinary reply stays destination-contained. Authorized
 * executor calls use their existing binding and policy, without this second veto.
 */
export const blocksPrivateConversationWrite = (input: {
  context: RunContext
  isExternal: boolean
  /**
   * The call is a project-operator verb this run was admitted to
   * (`projectOperatorToolIds`). Every one that writes names what it creates
   * from the conversation — a project, a channel, a column, a space, a
   * trigger's instructions, a workflow — into a place a wider audience reads,
   * and none carries a disclosure basis, so a private source closes them all.
   * Only on the operator arm: the Agent Designer's own home DM is a private
   * conversation, and the same verbs are its identity-delegated work there.
   */
  operatorVerb?: boolean
  toolName: string
}): boolean =>
  input.context.consumedSources.privateConversationSources().length > 0
  && input.context.agent.agentKind === 'shared'
  && (
    input.isExternal
    || UNSCOPED_CONTENT_SINKS.has(input.toolName)
    || (input.operatorVerb === true && !SAFE_BUILTIN_TOOL_IDS.has(input.toolName))
  )
