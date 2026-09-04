import {
  runEmailAccountAgentAccessTool,
  runEmailAccountCheckTool,
  runEmailAccountConnectTool,
  runEmailAccountDisconnectTool,
  runEmailAccountListTool,
  runEmailListTool,
  runEmailReadTool,
  runEmailSendTool,
} from './pa-tools.js'
import {
  runGmailAttachmentReadTool,
  runGmailLabelsListTool,
  runGmailOrganiseTool,
  runContactsSearchTool,
  runCalendarEventRespondTool,
} from './pa-tools/gmail-organise-tools.js'
import { runGmailDraftSendTool } from './pa-tools/gmail-send-tool.js'
import {
  runGmailDraftCreateTool,
  runGmailDraftUpdateTool,
  runGmailMessageReadTool,
  runGmailSearchTool,
  runGmailThreadReadTool,
} from './pa-tools/gmail-tools.js'
import {
  runMailboxReadTool,
  runMailboxSearchTool,
  runMailboxSendTool,
} from './pa-tools/mailbox-tools.js'
import type { AgenticToolResult, BuiltinToolRuntimeContext } from './tool-types.js'
import { wrapTool } from './tool-util.js'

/**
 * Mail and Google Workspace tool dispatch lives apart from the general builtin
 * switch because it has its own privacy/trust boundary and enough cases to
 * otherwise obscure unrelated tool routing.
 */
export const executeMailBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  inputSummary: string,
): Promise<AgenticToolResult | null> => {
  switch (toolName) {
    case 'email_list':
      return wrapTool(inputSummary, () => runEmailListTool(context, args))
    case 'email_read':
      return wrapTool(inputSummary, () => runEmailReadTool(context, args))
    case 'email_send':
      return wrapTool(inputSummary, () => runEmailSendTool(context, args))
    case 'email_account_list':
      return wrapTool(inputSummary, () => runEmailAccountListTool(context))
    case 'email_account_connect':
      return wrapTool(inputSummary, () => runEmailAccountConnectTool(context, args))
    case 'email_account_check':
      return wrapTool(inputSummary, () => runEmailAccountCheckTool(context, args))
    case 'email_account_disconnect':
      return wrapTool(inputSummary, () => runEmailAccountDisconnectTool(context, args))
    case 'email_account_agent_access':
      return wrapTool(inputSummary, () => runEmailAccountAgentAccessTool(context, args))
    case 'gmail_search':
      return wrapTool(inputSummary, () => runGmailSearchTool(context, args))
    case 'gmail_thread_read':
      return wrapTool(inputSummary, () => runGmailThreadReadTool(context, args))
    case 'gmail_message_read':
      return wrapTool(inputSummary, () => runGmailMessageReadTool(context, args))
    case 'gmail_draft_create':
      return wrapTool(inputSummary, () => runGmailDraftCreateTool(context, args))
    case 'gmail_draft_update':
      return wrapTool(inputSummary, () => runGmailDraftUpdateTool(context, args))
    case 'gmail_draft_send':
      return wrapTool(inputSummary, () => runGmailDraftSendTool(context, args))
    case 'gmail_labels_list':
      return wrapTool(inputSummary, () => runGmailLabelsListTool(context, args))
    case 'gmail_organise':
      return wrapTool(inputSummary, () => runGmailOrganiseTool(context, args))
    case 'gmail_attachment_read':
      return wrapTool(inputSummary, () => runGmailAttachmentReadTool(context, args))
    case 'contacts_search':
      return wrapTool(inputSummary, () => runContactsSearchTool(context, args))
    case 'mailbox_search':
      return wrapTool(inputSummary, () => runMailboxSearchTool(context, args))
    case 'mailbox_read':
      return wrapTool(inputSummary, () => runMailboxReadTool(context, args))
    case 'mailbox_send':
      return wrapTool(inputSummary, () => runMailboxSendTool(context, args))
    case 'calendar_event_respond':
      return wrapTool(inputSummary, () => runCalendarEventRespondTool(context, args))
    default:
      return null
  }
}
