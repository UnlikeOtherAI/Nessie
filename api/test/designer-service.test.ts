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

const fakeToolResponse = (name: string, args: Record<string, unknown>, id: string): Response => {
  const chunk = JSON.stringify({
    choices: [{ delta: { tool_calls: [{
      function: { arguments: JSON.stringify(args), name }, id, index: 0,
    }] } }],
  })
  const encoder = new TextEncoder()
  let sent = false
  const reader = {
    read: async () => {
      if (sent) return { done: true, value: undefined }
      sent = true
      return { done: false, value: encoder.encode(`data: ${chunk}\n\ndata: [DONE]\n\n`) }
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
  responses: Response[] = [fakeDoneResponse()],
): Promise<{ calls: number; systemPromptSent: string }> => {
  let capturedMessages: Array<{ content: string | null; role: string }> = []
  let calls = 0
  const modelClient = {
    chatModel: 'test-chat-model',
    fetchCompletion: async (body: Record<string, unknown>) => {
      calls += 1
      capturedMessages = body['messages'] as typeof capturedMessages
      return responses.shift() ?? fakeDoneResponse()
    },
    usage: { record: () => {} },
  } as unknown as ModelClient

  const { reply } = createFakeReply()

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
  return { calls, systemPromptSent: systemMessage!.content ?? '' }
}

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
  assert.match(
    systemPromptSent,
    /Controls available on this page: set name, role, instructions, model, and tool access/,
  )
})

test('an explicit page context with no actions stays read-only', async () => {
  const { systemPromptSent } = await runDesignerChat({
    messages: [], formState: baseFormState,
    pageContext: { actions: [], description: 'Review only.', title: 'Overview' },
  })
  assert.match(systemPromptSent, /Controls available on this page: none/)
})

test('sequential draft updates continue through the bounded Designer loop', async () => {
  const { calls } = await runDesignerChat({ messages: [], formState: baseFormState }, [
    fakeToolResponse('set_name', { name: 'Scout' }, 'name'),
    fakeToolResponse('set_role', { role: 'researcher' }, 'role'),
    fakeToolResponse('batch_toggle_tools', { tools: [{ enabled: false, toolId: 'web_search' }] }, 'tools'),
    fakeDoneResponse(),
  ])
  assert.equal(calls, 4)
})

test('a complete ordinary tool selection continues as one draft update', async () => {
  const { calls } = await runDesignerChat({ messages: [], formState: baseFormState }, [
    fakeToolResponse('set_tool_selection', {
      toolIds: ['5e1b3c8a-0000-4000-8000-00000000abcd'],
    }, 'selection'),
    fakeDoneResponse(),
  ])
  assert.equal(calls, 2)
})

test('an invalid complete selection stops before the form can partially apply it', async () => {
  const { calls } = await runDesignerChat({ messages: [], formState: baseFormState }, [
    fakeToolResponse('set_tool_selection', { toolIds: ['not-in-the-catalogue'] }, 'selection'),
    fakeDoneResponse(),
  ])
  assert.equal(calls, 1)
})

test('an unknown tool stops the Designer loop instead of being acknowledged as a draft update', async () => {
  const { calls } = await runDesignerChat({ messages: [], formState: baseFormState }, [
    fakeToolResponse('invent_access', {}, 'unknown'), fakeDoneResponse(),
  ])
  assert.equal(calls, 1)
})

test('a full bounded Designer loop reports that its explanation is unfinished', async () => {
  const responses = Array.from({ length: 6 }, (_, index) =>
    fakeToolResponse('set_name', { name: `Scout ${index}` }, `name-${index}`))
  const { calls } = await runDesignerChat({ messages: [], formState: baseFormState }, responses)
  assert.equal(calls, 6)
})
