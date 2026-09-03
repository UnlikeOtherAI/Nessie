import { createHash } from 'node:crypto'

import type { PrismaClient, VoiceSession } from '@prisma/client'
import {
  attributionFromActorContext,
  runWebSearch,
  WebSearchError,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { listThreadMessages } from '../messages.js'
import { VoiceSessionError } from './voice-session.js'

/**
 * What the assistant can actually do while you are talking to it.
 *
 * Every tool executes **server-side** with the caller's own authority. The
 * model chooses; it never holds a credential and never reaches anything the
 * person could not reach by typing. That is the whole security story, and it
 * is why the declarations can be handed to Gemini without widening anything.
 *
 * The set is smaller than the assistant's full typed toolset on purpose. A
 * spoken answer has to arrive in a couple of seconds, and every byte returned
 * here is re-billed on every subsequent turn of the call (Gemini re-sends the
 * accumulated context each turn), so results are capped far below the ordinary
 * chokepoint. Anything slower or larger goes through `pa_send`, which hands
 * the work to a normal run and speaks the answer when it lands.
 */

/**
 * Voice-sized result cap.
 *
 * The ordinary tool chokepoint allows 32,000 characters. That would be
 * ruinous here: the model re-sends its whole context every turn, so a single
 * fat result is paid for again on every exchange that follows it.
 */
const VOICE_RESULT_MAX_CHARS = 2_400

const truncateForVoice = (text: string): string =>
  text.length <= VOICE_RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, VOICE_RESULT_MAX_CHARS)}\n[…truncated for a spoken answer]`

export const hashToolArguments = (args: Record<string, unknown>): string =>
  // Key order from JSON.stringify is insertion order, which a retry preserves;
  // sorting makes the hash depend on the arguments rather than their spelling.
  createHash('sha256')
    .update(JSON.stringify(args, Object.keys(args).sort()))
    .digest('hex')

export type VoiceToolContext = {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
  prisma: PrismaClient
  session: VoiceSession
}

type VoiceTool = {
  declaration: Record<string, unknown>
  run: (args: Record<string, unknown>, context: VoiceToolContext) => Promise<Record<string, unknown>>
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

/**
 * Live web search, through the same Ledger-routed implementation the typed
 * agent uses — `runWebSearch` was moved into `@nessie/runtime` precisely so
 * both processes call one copy rather than forking it.
 */
const webSearchTool: VoiceTool = {
  declaration: {
    name: 'web_search',
    description:
      'Search the web for current information — news, facts, prices, anything you would otherwise be '
      + 'guessing at from memory. Returns a short list of results. Use it whenever the answer depends '
      + 'on something recent or something you are unsure of, and say what you found in your own words.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'What to search for, as a search query.' },
      },
      required: ['query'],
    },
  },
  run: async (args, context) => {
    const query = asString(args['query'])
    if (!query) return { ok: false, error: 'No search query was provided.' }
    try {
      const output = await runWebSearch(query, {
        attribution: attributionFromActorContext(context.actorContext, {
          agentId: context.session.agentId,
          agentKind: 'personal_assistant',
          systemComponent: 'voice-call',
        }),
        count: 4,
        ledgerIdentity: context.ledgerIdentity,
        toolCallId: `voice:${context.session.id}`,
      })
      const results = (output.results ?? []).slice(0, 4).map((result) => ({
        title: result.title,
        snippet: truncateForVoice(result.snippet ?? ''),
        url: result.url,
      }))
      return { ok: true, results }
    } catch (error) {
      if (error instanceof WebSearchError) return { ok: false, error: error.message }
      return { ok: false, error: 'The search could not be completed.' }
    }
  },
}

/**
 * Older conversation, on demand.
 *
 * The call seeds only a small recent slice, because Gemini re-bills the whole
 * accumulated context on every turn — a generous seed is not paid once, it is
 * paid again every time anyone speaks. This is the escape hatch: reach further
 * back only when the conversation actually needs it.
 */
const conversationHistoryTool: VoiceTool = {
  declaration: {
    name: 'conversation_history',
    description:
      'Read further back in this conversation than you were given at the start. Use it when the person '
      + 'refers to something you cannot see — an earlier decision, a name, a number. Optionally filter '
      + 'by a word or phrase to find the relevant part.',
    parameters: {
      type: 'OBJECT',
      properties: {
        contains: {
          type: 'STRING',
          description: 'Optional word or phrase to look for. Omit to read the most recent stretch.',
        },
      },
    },
  },
  run: async (args, context) => {
    const page = await listThreadMessages(context.prisma, context.session.threadId, {
      limit: 120,
      organizationId: context.session.organizationId,
      // The caller is the viewer, so the disclosure predicate is the same one
      // the DM itself renders through — a message they cannot see stays unseen.
      viewerUserId: context.session.userId,
    })
    const needle = asString(args['contains'])?.toLowerCase() ?? null
    const matched = page.data
      .filter((message) => !message.deletedAt && message.content.trim().length > 0)
      .filter((message) => (needle ? message.content.toLowerCase().includes(needle) : true))
      .slice(0, 20)
      .reverse()
      .map((message) => ({
        who: message.role === 'user' ? 'person' : 'assistant',
        when: message.createdAt,
        text: truncateForVoice(message.content),
      }))
    return matched.length === 0
      ? { ok: true, found: 0, note: 'Nothing further back matches.' }
      : { ok: true, found: matched.length, messages: matched }
  },
}

/**
 * Hand work to the assistant's own longer-running self.
 *
 * Posts an ordinary user message through the normal path, so the run it starts
 * is indistinguishable from one the person typed and every existing gate
 * applies. It answers immediately — Gemini Live blocks the conversation until
 * a tool responds, and a real run takes far longer than a person will wait.
 */
const handOffTool: VoiceTool = {
  declaration: {
    name: 'pa_send',
    description:
      'Hand a request to your own longer-running work: anything you cannot answer in a sentence or two '
      + 'right now — research, multi-step tasks, changing something, or work needing tools you do not '
      + 'have here. It starts immediately and the answer comes back to you as its own turn, so tell the '
      + 'person you are on it and keep talking.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: {
          type: 'STRING',
          description:
            'The request, written as the person would have typed it, complete enough to act on without '
            + 'the call for context.',
        },
      },
      required: ['text'],
    },
  },
  // Dispatched by the client, which posts the message as the person through
  // the ordinary message route with their own session. Executing it here would
  // mean forking message-create's post-commit work (orchestration, push,
  // realtime) into the voice path.
  run: async () => ({ ok: false, error: 'pa_send is dispatched by the client.' }),
}

const TOOLS: Record<string, VoiceTool> = {
  conversation_history: conversationHistoryTool,
  pa_send: handOffTool,
  web_search: webSearchTool,
}

/** Declarations for Gemini's `setup`, in a fixed order. */
export const voiceToolDeclarations = (): Array<Record<string, unknown>> =>
  Object.keys(TOOLS)
    .sort()
    .map((name) => TOOLS[name]?.declaration)
    .filter((declaration): declaration is Record<string, unknown> => declaration !== undefined)

/** The names the model has, for the system instruction — so it stops guessing. */
export const voiceToolNames = (): string[] => Object.keys(TOOLS).sort()

export const isVoiceTool = (name: string): boolean => name in TOOLS

/**
 * Runs one tool.
 *
 * `pa_send` is deliberately absent: the route owns it, because posting a
 * message carries post-commit work (orchestration, push, realtime) that lives
 * with the message-create path and must not be duplicated here.
 */
export const runVoiceTool = async (
  name: string,
  args: Record<string, unknown>,
  context: VoiceToolContext,
): Promise<Record<string, unknown>> => {
  const tool = TOOLS[name]
  if (!tool) {
    throw new VoiceSessionError('VOICE_TOOL_UNKNOWN', `Unknown tool: ${name}`, 400)
  }
  return tool.run(args, context)
}
