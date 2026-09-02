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
): Promise<{ systemPromptSent: string }> => {
  let capturedMessages: Array<{ content: string | null; role: string }> = []
  const modelClient = {
    chatModel: 'test-chat-model',
    fetchCompletion: async (body: Record<string, unknown>) => {
      capturedMessages = body['messages'] as typeof capturedMessages
      return fakeDoneResponse()
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
      modelProvider: 'openai',
      prisma: {} as PrismaClient,
    },
    {},
  )

  const systemMessage = capturedMessages.find((m) => m.role === 'system')
  assert.ok(systemMessage, 'a system message was sent to the model')
  return { systemPromptSent: systemMessage!.content ?? '' }
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

test('streamDesignerChat falls back to the default page description when none is supplied', async () => {
  const { systemPromptSent } = await runDesignerChat({
    messages: [],
    formState: baseFormState,
  })

  assert.match(systemPromptSent, /- Agent configuration: Edit this agent’s configuration\./)
  assert.match(systemPromptSent, /Controls available on this page: none/)
})
