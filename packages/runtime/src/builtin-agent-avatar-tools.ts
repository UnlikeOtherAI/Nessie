import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * The portrait pair of the agent-administration verbs — `agent_avatar_generate`
 * draws a replacement in a named style, `agent_avatar_update` sets one — split
 * out of `builtin-agent-tools.ts` because that file is at the cap. Spliced back
 * into `AGENT_ADMIN_TOOL_DEFINITIONS` at the same position, so definition order
 * (which the deferred toolset's promotion walk follows) is unchanged.
 */
export const AGENT_AVATAR_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'agent_avatar_generate',
    category: 'agents',
    summary: 'Draw an agent a new portrait in a named style.',
    label: 'Generate Agent Avatar',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Generate a portrait for an agent and set it, the same billed generation '
      + 'the avatar dialog runs. Every agent already gets one when it is '
      + 'created, so this is for a person who wants a different look. `style` '
      + 'is the look their portraits are drawn in — "cartoon", "photoreal", '
      + '"flat vector", whatever words they used — and is REMEMBERED as their '
      + 'preference for every portrait after this one, so pass it only when '
      + 'they have said what they like; omit it to use the style they already '
      + 'chose. `instructions` describe this one picture ("give her a hard '
      + 'hat") and are forgotten afterwards. Follows the same edit authority as '
      + 'agent_update.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent to draw.' },
        style: {
          type: 'string',
          description:
            'The durable look, in the person’s own words. Remembered as their '
            + 'preference. Omit to keep the style they already chose.',
        },
        instructions: {
          type: 'string',
          description:
            'One-off guidance for this portrait only. Never remembered.',
        },
      },
      required: ['agentId'],
    },
    safe: false,
  },
  {
    id: 'agent_avatar_update',
    category: 'agents',
    summary: 'Set or clear an agent’s portrait.',
    label: 'Update Agent Avatar',
    personalAssistantOnly: true,
    identityDelegatedOnly: true,
    description:
      'Attach an already-stored image as an agent’s portrait, or clear the one '
      + 'it has. Follows the same edit authority as agent_update. Newly created '
      + 'agents already get a generated portrait, so this is for an image the '
      + 'person supplied; to draw a new one instead, use agent_avatar_generate.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent whose portrait changes.' },
        avatarAttachmentId: {
          type: 'string',
          description:
            'Attachment id of the image to use. Send null to clear the portrait.',
        },
        avatarBackgroundColor: {
          type: 'string',
          description: 'Optional tile colour behind the portrait, as a hex value.',
        },
      },
      required: ['agentId'],
    },
    safe: false,
  },
]
