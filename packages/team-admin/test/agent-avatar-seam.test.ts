import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { generateAvatarForNewAgent } from '../src/agent-avatar-generation.js'

/**
 * The one generate-then-attach seam both creation paths run — the create route
 * and the assistant's `agent_create` tool. Before it existed only the route
 * generated a face, so an agent made in chat was the only faceless one.
 *
 * The rule it encodes: a picture is never worth failing a creation for.
 */

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-avatar-seam' },
  actor: { actorId: '00000000-0000-4000-8000-0000000000a1', actorType: 'user' },
  tenant: {
    organizationId: '00000000-0000-4000-8000-0000000000a2',
    projectId: '00000000-0000-4000-8000-0000000000a3',
    teamId: '00000000-0000-4000-8000-0000000000a4',
  },
}

const config = {
  apiKey: 'lk_nessie_test',
  baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
}

const agent = { name: 'Release Shepherd', role: 'deployment coordinator' }

const fileService = {
  store: async () => ({ attachment: { id: '00000000-0000-4000-8000-0000000000a5' } }),
} as never

const modelClient = { chat: async () => 'a portrait prompt' }

const imageRequest = async () =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from('generated-image-bytes').toString('base64') }],
    }),
    { status: 200 },
  )

test('generates and returns an avatar for a new agent', async () => {
  const generated = await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    fileService,
    imageRequest,
    ledgerIdentity: null,
    modelClient,
  })
  assert.equal(generated?.avatarAttachmentId, '00000000-0000-4000-8000-0000000000a5')
  assert.match(generated?.avatarBackgroundColor ?? '', /^#/)
})

test('an avatar the person already chose is left alone', async () => {
  let called = false
  const generated = await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    existingAvatarAttachmentId: '00000000-0000-4000-8000-0000000000a6',
    fileService,
    imageRequest: async () => {
      called = true
      return new Response('{}', { status: 200 })
    },
    ledgerIdentity: null,
    modelClient,
  })
  assert.equal(generated, undefined)
  assert.equal(called, false, 'no billed generation for an agent that has a picture')
})

test('a failed picture never fails the creation', async () => {
  const failures: unknown[] = []
  const generated = await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    fileService,
    imageRequest: async () => new Response('nope', { status: 502 }),
    ledgerIdentity: null,
    modelClient,
    onFailure: (error) => failures.push(error),
  })
  assert.equal(generated, undefined)
  assert.equal(failures.length, 1)
})

test('an unconfigured deployment reports rather than throws', async () => {
  const failures: unknown[] = []
  const generated = await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    fileService: null,
    ledgerIdentity: null,
    modelClient: null,
    onFailure: (error) => failures.push(error),
  })
  assert.equal(generated, undefined)
  assert.match(
    failures[0] instanceof Error ? failures[0].message : '',
    /model service is not configured/,
  )
})

test('a remembered style reaches the prompt writer as descriptive data', async () => {
  const seen: unknown[] = []
  await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    fileService,
    imageRequest,
    ledgerIdentity: null,
    modelClient: {
      chat: async (messages) => {
        seen.push(messages)
        return 'a portrait prompt'
      },
    },
    style: 'photorealistic, natural light',
  })

  const messages = seen[0] as { role: string; content: string }[]
  const system = messages.find((message) => message.role === 'system')?.content ?? ''
  const user = messages.find((message) => message.role === 'user')?.content ?? ''
  // The person's own words describe the picture; they never become rules for
  // the writer, which is why they travel in the user message alone.
  assert.equal(system.includes('photorealistic'), false)
  assert.equal(
    JSON.parse(user).avatarStyle,
    'photorealistic, natural light',
    'the style is a field of the descriptive JSON',
  )
  assert.match(system, /avatarStyle/)
})

test('with no style the writer keeps its default look', async () => {
  const seen: unknown[] = []
  await generateAvatarForNewAgent({
    actorContext,
    agent,
    config,
    fileService,
    imageRequest,
    ledgerIdentity: null,
    modelClient: {
      chat: async (messages) => {
        seen.push(messages)
        return 'a portrait prompt'
      },
    },
  })

  const messages = seen[0] as { role: string; content: string }[]
  const user = messages.find((message) => message.role === 'user')?.content ?? ''
  assert.equal('avatarStyle' in JSON.parse(user), false)
  assert.match(
    messages.find((message) => message.role === 'system')?.content ?? '',
    /clean cartoon style when there is not/,
  )
})
