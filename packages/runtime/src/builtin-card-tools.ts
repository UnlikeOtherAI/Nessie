import { CardPostToolInputSchema, CardPostToolOutputSchema } from '@nessie/schemas'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const CARD_POST_TOOL_ID = 'card_post'

/**
 * Post an interactive card into the conversation.
 *
 * Deliberately an ordinary default-allow builtin with no `personalAssistantOnly`
 * and no `requiresExplicitGrant`: every agent that can talk can already post
 * prose, and a card is a better-shaped message, not a wider permission. What a
 * card *does* — connect an app, store a credential — is gated where it always
 * was, at the tool the agent calls afterwards. A per-agent `card_post: false`
 * policy remains an ordinary hard deny.
 */
export const CARD_POST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: CARD_POST_TOOL_ID,
  category: 'conversation',
  summary: 'Post an interactive card with buttons into this conversation.',
  label: 'Post card',
  description:
    'Post a persistent card into this conversation — a ticket or email overview, an image '
    + 'with a caption, a small form — with buttons the person presses. Build the body from '
    + 'blocks: text (markdown), fields (label/value pairs), image (an attachment id you can '
    + 'already reach, never a URL), link (https), input (text, textarea, number, select, '
    + 'checkbox, date) and secret (a masked field whose value goes straight to the encrypted '
    + 'credential store and is never shown to you or recorded in the conversation — you learn '
    + 'only that it was provided). Give each action a short label such as Allow, OK, Send or '
    + 'Cancel, and set submits:false on the ones that dismiss without reading the inputs. '
    + 'Pressing resolves the card permanently: the answer arrives as a message in the '
    + 'conversation and the card freezes showing what was decided and by whom. '
    + 'Set respondents to choose who may press ("requester" — the person who asked, the '
    + 'default; "thread" — anyone in the conversation; or specific userIds). Set wait:true to '
    + 'pause here until somebody presses, instead of finishing your turn and being brought '
    + 'back when they do. Set expiresIn (seconds) if the card should stop accepting answers.',
  parameters: {
    type: 'object',
    properties: {
      card: {
        type: 'object',
        description: 'The card to show.',
        properties: {
          schemaVersion: { type: 'integer', enum: [1] },
          service: {
            type: 'object',
            description:
              'The service this card is about, shown as a small mark in the top-left corner. '
              + 'Use the service slug, e.g. {"key":"linear","label":"Linear"}.',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['key', 'label'],
          },
          title: { type: 'string', description: 'Short headline, e.g. the ticket title.' },
          subtitle: { type: 'string' },
          blocks: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            description:
              'Body blocks in display order. Each is one of: '
              + '{"type":"text","markdown":"…"}; '
              + '{"type":"fields","items":[{"label":"Status","value":"In progress"}]}; '
              + '{"type":"image","attachmentId":"<uuid>","alt":"…","caption":"…"}; '
              + '{"type":"link","href":"https://…","label":"…"}; '
              + '{"type":"input","key":"environment","label":"Environment","input":"select",'
              + '"options":[{"value":"prod","label":"Production"}],"required":true}; '
              + '{"type":"secret","key":"api_key","label":"API key",'
              + '"destination":{"kind":"connector_credential","instanceId":"<uuid>"}}.',
            items: { type: 'object' },
          },
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            description:
              'Buttons along the bottom, e.g. '
              + '[{"key":"allow","label":"Allow","style":"primary","submits":true},'
              + '{"key":"cancel","label":"Cancel","style":"secondary","submits":false}].',
            items: { type: 'object' },
          },
        },
        required: ['schemaVersion', 'title', 'blocks', 'actions'],
      },
      respondents: {
        description:
          'Who may press: "requester" (default when a person asked for this run), "thread" '
          + '(anyone who can see the conversation), or {"userIds":["<uuid>"]}.',
      },
      wait: {
        type: 'boolean',
        description:
          'Pause this run until somebody presses a button, then continue with their answer. '
          + 'Leave unset to finish your turn now and be woken by the press instead.',
      },
      expiresIn: {
        type: 'integer',
        minimum: 60,
        maximum: 2592000,
        description: 'Seconds until the card stops accepting an answer. Omit for no expiry.',
      },
    },
    required: ['card'],
  },
  safe: false,
  inputSchema: CardPostToolInputSchema,
  outputSchema: CardPostToolOutputSchema,
}

export const CARD_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [CARD_POST_TOOL_DEFINITION]
