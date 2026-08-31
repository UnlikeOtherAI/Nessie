import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const COMMS_CONNECT_CARD_TOOL_ID = 'comms_connect_card'
export const MEETING_LINK_CREATE_TOOL_ID = 'meeting_link_create'
export const CALL_START_TOOL_ID = 'call_start'

/**
 * Personal-assistant-only presentation tool. Posts a `comms_connect` card into
 * the current thread offering the user buttons to link their Slack / Gmail /
 * Microsoft accounts. It is deliberately thin: it carries no connector logic —
 * the card's buttons drive the authenticated `/api/comms/connections/:provider/
 * start` OAuth flow client-side.
 */
export const COMMS_CONNECT_CARD_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: COMMS_CONNECT_CARD_TOOL_ID,
  label: 'Communications Connect Card',
  personalAssistantOnly: true,
  description:
    'Present the user with a card to connect their communication accounts ' +
    '(Slack, Gmail, Microsoft) so you can help across their messages. Posts the ' +
    'card into the current chat; the user clicks a provider button to authorize.',
  parameters: {
    type: 'object',
    properties: {
      providers: {
        type: 'array',
        items: { type: 'string', enum: ['slack', 'google', 'microsoft'] },
        description:
          'Providers to offer. Defaults to slack + google when omitted.',
      },
    },
  },
  safe: false,
}

/**
 * These tools mint links with the requesting person's Google or Microsoft
 * identity, so they are personal-assistant-only just like the channel tools
 * that act with a person's own authority. They deliberately do not require an
 * explicit grant: the product decision is that a person asking their PA for a
 * call should work immediately. Keeping link creation and ringing as separate
 * ids preserves the option to add an explicit grant to ringing later.
 */
export const MEETING_LINK_CREATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: MEETING_LINK_CREATE_TOOL_ID,
  label: 'Create Meeting Link',
  personalAssistantOnly: true,
  description:
    'Create a provider meeting link using the requesting user’s connection. '
    + 'Use the team’s configured call provider unless the user explicitly asks '
    + 'for another provider they have connected.',
  parameters: {
    type: 'object',
    properties: {
      teamId: {
        type: 'string',
        description: 'The team whose configured call provider should be used.',
      },
      provider: {
        type: 'string',
        enum: ['google_meet', 'jitsi', 'microsoft_teams'],
        description:
          'Optional provider override requested by the user. Omit to use the team default.',
      },
    },
    required: ['teamId'],
  },
  safe: false,
}

export const CALL_START_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: CALL_START_TOOL_ID,
  label: 'Start Channel Call',
  personalAssistantOnly: true,
  description:
    'Create a meeting link and ring every other active member of the target '
    + 'channel. Use only after the requesting user asks to start the call.',
  parameters: {
    type: 'object',
    properties: {
      channelId: {
        type: 'string',
        description: 'The channel whose members should receive the call ring.',
      },
      provider: {
        type: 'string',
        enum: ['google_meet', 'jitsi', 'microsoft_teams'],
        description:
          'Optional provider override requested by the user. Omit to use the target channel team default.',
      },
    },
    required: ['channelId'],
  },
  safe: false,
}

export const COMMS_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  COMMS_CONNECT_CARD_TOOL_DEFINITION,
  MEETING_LINK_CREATE_TOOL_DEFINITION,
  CALL_START_TOOL_DEFINITION,
]
