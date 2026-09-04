import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { ModelClient } from '@nessie/runtime'
import type { FastifyReply } from 'fastify'

import { streamDesignerChat } from '../src/services/designer.js'
import type { DesignerChatInput } from '../src/services/designer-prompt.js'

// This suite guards the wiring between the route/service input and
// `buildDesignerSystemPrompt`: `streamDesignerChat` must forward every field
// of `DesignerChatInput` — including `pageContext` — into the system prompt
// it sends to the model. `pageContext` was previously dropped on the call,
// so the "only act on controls this page offers" rule was enforced
// client-side only.
//
// It also guards the phase-4 unification (D9): the tool catalogue is read from
// the database by the service, not sent by the browser, so a registry row this
// organisation has must reach the prompt without the client saying anything.

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId },
  tenant: { organizationId },
  actionContext: { requestId: 'req-designer-test' },
}

const baseFormState: DesignerChatInput['formState'] = {
  name: '',
  role: '',
  systemPrompt: '',
  provider: '',
  model: '',
  tools: {},
}

/**
 * Minimal SSE body: a single `[DONE]` line, so `streamModelTurn` returns
 * immediately with no tool calls and the loop exits after one round.
 */
const fakeDoneResponse = (): Response => {
  const encoder = new TextEncoder()
  let sent = false
  const reader = {
    read: async () => {
      if (sent) return { done: true, value: undefined }
      sent = true
      return { done: false, value: encoder.encode('data: [DONE]\n\n') }
    },
    releaseLock: () => {},
  }
  return { body: { getReader: () => reader } } as unknown as Response
}

const fakeStreamResponse = (lines: string[], includeDone = true): Response => {
  const encoder = new TextEncoder()
  let sent = false
  const reader = {
    read: async () => {
      if (sent) return { done: true, value: undefined }
      sent = true
      return {
        done: false,
        value: encoder.encode(
          `${lines.map((entry) => `data: ${entry}\n\n`).join('')}${includeDone ? 'data: [DONE]\n\n' : ''}`,
        ),
      }
    },
    releaseLock: () => {},
  }
  return { body: { getReader: () => reader } } as unknown as Response
}

/**
 * The registry reads `loadAgentToolCatalog` performs. A cast fake is unityped,
 * so a delegate it does not model is a runtime TypeError — this pair is exactly
 * what the catalogue queries, and the connector row proves the service reads
 * the organisation's own rows rather than a client-supplied list.
 */
const fakePrisma = (): PrismaClient => ({
  toolRegistryEntry: {
    findMany: async (args: { where?: { builtin?: boolean } }) =>
      (args.where?.builtin === true
        ? []
        : [
            {
              description: 'Create a ticket in the tracker.',
              handlerKind: 'mcp',
              id: '5e1b3c8a-0000-4000-8000-00000000abcd',
              label: 'Ticket create',
              metadata: null,
              toolId: 'ticket_create',
            },
          ]),
  },
} as unknown as PrismaClient)

const createFakeReply = (): { chunks: string[]; reply: FastifyReply } => {
  const chunks: string[] = []
  const raw = {
    writeHead: () => raw,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: () => {},
    socket: { setNoDelay: () => {} },
  }
  return { chunks, reply: { raw } as unknown as FastifyReply }
}

const runDesignerChat = async (
  input: DesignerChatInput,
  response: Response = fakeDoneResponse(),
): Promise<{ chunks: string[]; systemPromptSent: string }> => {
  let capturedMessages: Array<{ content: string | null; role: string }> = []
  const modelClient = {
    chatModel: 'test-chat-model',
    fetchCompletion: async (body: Record<string, unknown>) => {
      capturedMessages = body['messages'] as typeof capturedMessages
      return response
    },
    usage: { record: () => {} },
  } as unknown as ModelClient

  const { chunks, reply } = createFakeReply()

  await streamDesignerChat(
    reply,
    input,
    modelClient,
    {
      actorContext,
      designerModel: 'test-chat-model',
      ledgerIdentity: null,
      modelProvider: 'openai',
      prisma: fakePrisma(),
    },
    {},
  )

  const systemMessage = capturedMessages.find((m) => m.role === 'system')
  assert.ok(systemMessage, 'a system message was sent to the model')
  return { chunks, systemPromptSent: systemMessage!.content ?? '' }
}

test('Designer output streams and tool arguments never expose model-produced secrets', async () => {
  const secret = 'password="hunter2"'
  const response = fakeStreamResponse([
    JSON.stringify({ choices: [{ delta: { content: secret } }] }),
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            function: { arguments: JSON.stringify({ content: secret }), name: 'set_system_prompt' },
            id: 'call-secret',
            index: 0,
          }],
        },
      }],
    }),
  ])
  const { chunks } = await runDesignerChat({ messages: [], formState: baseFormState }, response)
  const streamed = chunks.join('')

  assert.doesNotMatch(streamed, /hunter2/u)
  assert.match(streamed, /\[REDACTED_SECRET\]/u)
})

test('Designer sanitizes open tool arguments when a provider ends at EOF', async () => {
  const secret = 'password="hunter2"'
  const response = fakeStreamResponse([JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          function: { arguments: JSON.stringify({ content: secret }), name: 'set_system_prompt' },
          id: 'call-secret-eof',
          index: 0,
        }],
      },
    }],
  })], false)
  const { chunks } = await runDesignerChat({ messages: [], formState: baseFormState }, response)

  assert.doesNotMatch(chunks.join(''), /hunter2/u)
  assert.match(chunks.join(''), /\[REDACTED_SECRET\]/u)
})

test('streamDesignerChat forwards the supplied page context into the system prompt', async () => {
  const { systemPromptSent } = await runDesignerChat({
    messages: [],
    formState: baseFormState,
    pageContext: {
      title: 'Tools',
      description: 'Review and change this agent’s tool access.',
      actions: ['enable or disable tools, then save the changes'],
    },
  })

  assert.match(systemPromptSent, /- Tools: Review and change this agent’s tool access\./)
  assert.match(
    systemPromptSent,
    /Controls available on this page: enable or disable tools, then save the changes/,
  )
})

test('the tool catalogue reaches the prompt from the database, not the browser', async () => {
  const { systemPromptSent } = await runDesignerChat({
    messages: [],
    formState: baseFormState,
  })

  // The connector row this organisation has, keyed by its registry uuid — the
  // request carried no tool list at all.
  assert.match(systemPromptSent, /5e1b3c8a-0000-4000-8000-00000000abcd \(Ticket create\)/)
  // And the persona is the blueprint's, not a second one written here.
  assert.match(systemPromptSent, /You are the Agent Designer/)
  // The sidebar drives an unsaved form; it must never claim it created an agent.
  assert.match(systemPromptSent, /never say an agent has been created or changed/)
})

test('an unconfigured Ledger makes the prompt say search is unavailable', async () => {
  // Stated rather than inherited: a deployment WITH Ledger configured would
  // otherwise make this pass or fail by accident of the runner's environment.
  const ledgerUrl = process.env['LEDGER_PUBLIC_URL']
  const ledgerToken = process.env['LEDGER_PROXY_TOKEN']
  delete process.env['LEDGER_PUBLIC_URL']
  delete process.env['LEDGER_PROXY_TOKEN']
  try {
    const { systemPromptSent } = await runDesignerChat({
      messages: [],
      formState: baseFormState,
    })

    assert.match(systemPromptSent, /web_search is not configured on this deployment/)
  } finally {
    if (ledgerUrl !== undefined) process.env['LEDGER_PUBLIC_URL'] = ledgerUrl
    if (ledgerToken !== undefined) process.env['LEDGER_PROXY_TOKEN'] = ledgerToken
  }
})

test('streamDesignerChat falls back to the default page description when none is supplied', async () => {
  const { systemPromptSent } = await runDesignerChat({
    messages: [],
    formState: baseFormState,
  })

  assert.match(systemPromptSent, /- Agent configuration: Edit this agent’s configuration\./)
  assert.match(systemPromptSent, /Controls available on this page: none/)
})
