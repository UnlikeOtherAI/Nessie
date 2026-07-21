import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const COMMS_CONNECT_CARD_TOOL_ID = 'comms_connect_card'

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

export const COMMS_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  COMMS_CONNECT_CARD_TOOL_DEFINITION,
]
