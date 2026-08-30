import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import { AGENT_AVATAR_BACKGROUND_COLORS } from '@nessie/schemas'

import {
  AgentAvatarGenerationError,
  generateAgentAvatar,
} from '../src/services/agent-avatar-generation.js'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-avatar-1' },
  actor: { actorId: '00000000-0000-4000-8000-000000000001', actorType: 'user' },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
}

test('generates a gpt-image-2 avatar through Ledger and stores it as an attachment preview', async () => {
  let promptMessages: unknown
  let imageRequest: { body: Record<string, unknown>; headers: Headers; url: string } | null = null
  let stored: { body: NodeJS.ReadableStream; input: Record<string, unknown> } | null = null

  const generated = await generateAgentAvatar({
    actorContext,
    agent: {
      id: '00000000-0000-4000-8000-000000000005',
      name: 'Release Shepherd',
      role: 'deployment coordinator',
      systemPrompt: 'Keep releases predictable and communicate risks early.',
    },
    config: {
      apiKey: 'lk_nessie_test',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
    },
    fileService: {
      store: async (input) => {
        stored = { body: input.body, input }
        return { attachment: { id: '00000000-0000-4000-8000-000000000006' } }
      },
    } as never,
    imageRequest: async (url, init) => {
      imageRequest = {
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: new Headers(init.headers),
        url: url.toString(),
      }
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('generated-image-bytes').toString('base64') }],
      }), { status: 200 })
    },
    ledgerIdentity: {
      requestHeaders: async () => ({
        'X-Nessie-Context': 'signed-nessie-context',
        'X-UOA-Delegation': 'signed-uoa-delegation',
      }),
    },
    modelClient: {
      chat: async (messages) => {
        promptMessages = messages
        return 'A cheerful illustrated release coordinator in a clean cartoon headshot.'
      },
    },
  })

  assert.equal(generated.avatarAttachmentId, '00000000-0000-4000-8000-000000000006')
  assert.ok(AGENT_AVATAR_BACKGROUND_COLORS.includes(generated.avatarBackgroundColor))
  assert.equal(imageRequest?.url, 'https://ledger.unlikeotherai.com/v1/openai/images/generations')
  assert.equal(imageRequest?.body.model, 'gpt-image-2')
  assert.equal(imageRequest?.body.response_format, undefined)
  assert.equal(imageRequest?.headers.get('authorization'), 'Bearer lk_nessie_test')
  assert.equal(imageRequest?.headers.get('x-nessie-context'), 'signed-nessie-context')
  assert.equal(imageRequest?.headers.get('x-uoa-delegation'), 'signed-uoa-delegation')
  assert.ok(stored)
  assert.equal(stored.input.filename, 'agent-avatar.png')
  assert.equal(stored.input.mime, 'image/png')
  assert.equal(stored.input.organizationId, actorContext.tenant.organizationId)
  assert.equal(stored.input.uploaderId, actorContext.actor.actorId)
  assert.deepEqual(stored.input.scope, {
    projectId: actorContext.tenant.projectId,
    teamId: actorContext.tenant.teamId,
  })
  assert.equal(stored.input.attribution.systemComponent, 'agent-avatar-image')
  assert.equal(stored.input.attribution.agentId, '00000000-0000-4000-8000-000000000005')
  assert.ok(Array.isArray(promptMessages))
  assert.equal(promptMessages[0]?.role, 'system')
  assert.equal(promptMessages[1]?.role, 'user')
  assert.match(String(promptMessages[0]?.content), /Default to one original fictional human character/)
  assert.match(String(promptMessages[0]?.content), /Do not use a robot, machine, AI mascot/)
  assert.match(String(promptMessages[0]?.content), /never from a keyword list/)
})

test('routes image generation through the Ledger Purpose API when one is configured', async () => {
  let requestUrl: string | null = null

  await generateAgentAvatar({
    actorContext,
    agent: { id: '00000000-0000-4000-8000-000000000005', name: 'Release Shepherd', role: 'deployment coordinator' },
    config: {
      apiKey: 'lk_nessie_test',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
      imagePurposeApiId: 'pa_nessie_avatar',
    },
    fileService: {
      store: async () => ({ attachment: { id: '00000000-0000-4000-8000-000000000006' } }),
    } as never,
    imageRequest: async (url) => {
      requestUrl = url.toString()
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('generated-image-bytes').toString('base64') }],
      }), { status: 200 })
    },
    ledgerIdentity: null,
    modelClient: { chat: async () => 'A cheerful illustrated release coordinator.' },
  })

  // The direct /v1/openai/images/generations service route is replaced by the
  // purpose route, so Ledger owns the provider fallback chain.
  assert.equal(requestUrl, 'https://ledger.unlikeotherai.com/v1/purpose/pa_nessie_avatar/images/generations')
})

test('refuses to generate an avatar when the configured model endpoint is not Ledger', async () => {
  let promptCalled = false

  await assert.rejects(
    generateAgentAvatar({
      actorContext,
      agent: { name: 'Researcher', role: 'analyst' },
      config: { apiKey: 'sk-direct-provider-key', baseUrl: 'https://api.openai.com/v1' },
      fileService: { store: async () => ({ attachment: { id: 'unused' } }) } as never,
      ledgerIdentity: null,
      modelClient: {
        chat: async () => {
          promptCalled = true
          return 'should not run'
        },
      },
    }),
    AgentAvatarGenerationError,
  )

  assert.equal(promptCalled, false)
})
