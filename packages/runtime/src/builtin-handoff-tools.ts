import {
  AgentHandoffToolInputSchema,
  AgentHandoffToolOutputSchema,
} from '@nessie/schemas'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const AGENT_HANDOFF_TOOL_ID = 'agent_handoff'

/**
 * Pass the conversation to a global agent.
 *
 * Default-on for every agent that can talk (`safe: false`, no explicit grant):
 * the blast radius is a briefing into the requesting person's own private DM
 * with a built-in agent plus a doorway message in the room the ask came from.
 * Nothing it writes carries authority the origin run did not already have.
 *
 * The *bounds* are structural and live outside this definition:
 * `authorizeToolCall` withholds it from any agent carrying a `systemSlug` (a
 * global agent cannot hand off to itself or a future peer) and from
 * `spawn_subtask` children, and the handler refuses any run without a live,
 * interactive human requester. WHETHER to hand off stays the model's judgement,
 * steered by the structural routing block in the system prompt.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D8).
 */
export const AGENT_HANDOFF_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: AGENT_HANDOFF_TOOL_ID,
  category: 'agents',
  summary: 'Hand this conversation to a built-in specialist agent.',
  label: 'Hand off to a specialist',
  description:
    'Open (or continue) the person\'s own private conversation with a built-in specialist '
    + 'agent and brief it on what they want. Use it when the request is that specialist\'s '
    + 'job rather than yours — say so in your own words first. Write the brief as a short '
    + 'handover note to a colleague: what the person asked for, the details they already '
    + 'gave, and anything you found out that saves repeating the conversation. It is not '
    + 'shown to the person, so never put a question to them in it. You do not follow them '
    + 'there; the specialist replies in its own chat.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description:
          'The built-in specialist to hand to, by slug (e.g. "agent-designer"). '
          + 'Only the specialists named in your instructions exist.',
      },
      brief: {
        type: 'string',
        description:
          'The handover note for the specialist: the request in the person\'s own terms '
          + 'plus the context you already have. Never addressed to the person.',
      },
    },
    required: ['target', 'brief'],
  },
  safe: false,
  inputSchema: AgentHandoffToolInputSchema,
  outputSchema: AgentHandoffToolOutputSchema,
}

export const HANDOFF_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  AGENT_HANDOFF_TOOL_DEFINITION,
]
