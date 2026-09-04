import { z } from 'zod'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'
import {
  isStructuralApprovalTool,
  parseStructuralApprovalToolArgs,
} from './builtin-approval-inputs.js'

export const EMAIL_ACCOUNT_LIST_TOOL_ID = 'email_account_list'
export const EMAIL_ACCOUNT_CONNECT_TOOL_ID = 'email_account_connect'
export const EMAIL_ACCOUNT_CHECK_TOOL_ID = 'email_account_check'
export const EMAIL_ACCOUNT_DISCONNECT_TOOL_ID = 'email_account_disconnect'
export const EMAIL_ACCOUNT_AGENT_ACCESS_TOOL_ID = 'email_account_agent_access'

const AccountKindSchema = z.enum(['provider', 'mailbox'])

export const EmailAccountListToolInputSchema = z.object({}).strict()

export const EmailAccountConnectToolInputSchema = z.object({
  scope: z.enum(['user', 'team']).default('user'),
}).strict()

export const EmailAccountReferenceToolInputSchema = z.object({
  accountId: z.string().uuid(),
  accountKind: AccountKindSchema,
}).strict()

export const EmailAccountAgentAccessToolInputSchema = z.object({
  accountId: z.string().uuid(),
  agentId: z.string().uuid(),
  allowed: z.boolean(),
}).strict()

const EMAIL_ACCOUNT_TOOL_INPUT_SCHEMAS = {
  [EMAIL_ACCOUNT_LIST_TOOL_ID]: EmailAccountListToolInputSchema,
  [EMAIL_ACCOUNT_CONNECT_TOOL_ID]: EmailAccountConnectToolInputSchema,
  [EMAIL_ACCOUNT_CHECK_TOOL_ID]: EmailAccountReferenceToolInputSchema,
  [EMAIL_ACCOUNT_DISCONNECT_TOOL_ID]: EmailAccountReferenceToolInputSchema,
  [EMAIL_ACCOUNT_AGENT_ACCESS_TOOL_ID]: EmailAccountAgentAccessToolInputSchema,
} as const

/**
 * The lifecycle tools are a credential boundary. Their arguments are parsed
 * before policy, audit or approval handling so unrecognised fields (including
 * a model-provided password or OAuth code) cannot become durable state.
 */
export const parseToolAuthorizationArgs = (
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const schema = EMAIL_ACCOUNT_TOOL_INPUT_SCHEMAS[
    toolName as keyof typeof EMAIL_ACCOUNT_TOOL_INPUT_SCHEMAS
  ]
  return schema ? schema.parse(args) : parseStructuralApprovalToolArgs(toolName, args)
}

/** @deprecated Use parseToolAuthorizationArgs at the authorization chokepoint. */
export const parseEmailAccountToolArgs = parseToolAuthorizationArgs

export const isEmailAccountTool = (toolName: string): boolean =>
  Object.hasOwn(EMAIL_ACCOUNT_TOOL_INPUT_SCHEMAS, toolName)

export const hasStrictToolAuthorizationInput = (toolName: string): boolean =>
  isEmailAccountTool(toolName) || isStructuralApprovalTool(toolName)

const ACCOUNT_REFERENCE_PROPERTIES = {
  accountId: {
    description: 'The exact accountId returned by email_account_list.',
    type: 'string',
  },
  accountKind: {
    description:
      'provider for a Google or Microsoft OAuth account; mailbox for a live IMAP/SMTP mailbox.',
    enum: ['provider', 'mailbox'],
    type: 'string',
  },
}

/**
 * Account lifecycle is deliberately separate from message access. These tools
 * act as the requesting person and mirror the settings routes; mailbox_search,
 * mailbox_read and mailbox_send remain independently grantable to agents.
 */
export const EMAIL_ACCOUNT_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    category: 'email-calendar',
    description:
      'List the email accounts the requesting person may manage in this organisation. '
      + 'Returns exact accountKind and accountId values for follow-up account actions, '
      + 'including personal Google/Microsoft connections and entitled IMAP/SMTP mailboxes.',
    id: EMAIL_ACCOUNT_LIST_TOOL_ID,
    label: 'List Email Accounts',
    parameters: { properties: {}, type: 'object' },
    inputSchema: EmailAccountListToolInputSchema,
    personalAssistantOnly: true,
    safe: true,
    summary: 'List manageable email accounts and their connection state.',
  },
  {
    category: 'email-calendar',
    description:
      'Show the requesting person the secure address-first Connect email flow in chat. '
      + 'The person enters credentials only in the protected form or provider OAuth page; '
      + 'never ask them to paste an email password or OAuth code into the conversation.',
    id: EMAIL_ACCOUNT_CONNECT_TOOL_ID,
    label: 'Connect Email Account',
    parameters: {
      properties: {
        scope: {
          description:
            'user for the requesting person’s account (default), or team for a shared mailbox.',
          enum: ['user', 'team'],
          type: 'string',
        },
      },
      type: 'object',
    },
    inputSchema: EmailAccountConnectToolInputSchema,
    personalAssistantOnly: true,
    safe: false,
    summary: 'Open the secure email-account connection flow in chat.',
  },
  {
    category: 'email-calendar',
    description:
      'Check an email account the requesting person manages. A provider account queues '
      + 'the same initial or incremental sync as its settings card; an IMAP/SMTP mailbox '
      + 'tests both incoming access and outgoing authentication with its stored credential.',
    id: EMAIL_ACCOUNT_CHECK_TOOL_ID,
    label: 'Check Email Account',
    parameters: {
      properties: ACCOUNT_REFERENCE_PROPERTIES,
      required: ['accountKind', 'accountId'],
      type: 'object',
    },
    inputSchema: EmailAccountReferenceToolInputSchema,
    personalAssistantOnly: true,
    safe: false,
    summary: 'Check or refresh one connected email account.',
  },
  {
    category: 'email-calendar',
    description:
      'Disconnect one email account the requesting person manages. This removes the '
      + 'stored IMAP/SMTP credential, or revokes a provider grant when possible and '
      + 'always removes the local token. Requires human approval before it runs.',
    id: EMAIL_ACCOUNT_DISCONNECT_TOOL_ID,
    label: 'Disconnect Email Account',
    parameters: {
      properties: ACCOUNT_REFERENCE_PROPERTIES,
      required: ['accountKind', 'accountId'],
      type: 'object',
    },
    inputSchema: EmailAccountReferenceToolInputSchema,
    personalAssistantOnly: true,
    requiresApproval: true,
    safe: false,
    summary: 'Disconnect an email account after human approval.',
  },
  {
    category: 'email-calendar',
    description:
      'Grant or revoke one agent’s access to a connected IMAP/SMTP mailbox. This is the '
      + 'resource-level permission only: the agent also needs its mailbox_search, '
      + 'mailbox_read or mailbox_send tool grants for those actions.',
    id: EMAIL_ACCOUNT_AGENT_ACCESS_TOOL_ID,
    label: 'Manage Mailbox Agent Access',
    parameters: {
      properties: {
        accountId: {
          description: 'The mailbox accountId returned by email_account_list.',
          type: 'string',
        },
        agentId: {
          description: 'The exact agent id returned by agent_list.',
          type: 'string',
        },
        allowed: {
          description: 'true to grant mailbox access; false to revoke it.',
          type: 'boolean',
        },
      },
      required: ['accountId', 'agentId', 'allowed'],
      type: 'object',
    },
    inputSchema: EmailAccountAgentAccessToolInputSchema,
    personalAssistantOnly: true,
    safe: false,
    summary: 'Grant or revoke one agent’s access to an IMAP/SMTP mailbox.',
  },
]
