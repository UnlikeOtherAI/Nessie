import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import { AGENT_AVATAR_BACKGROUND_COLORS } from '@nessie/schemas'
import { AgentAvatarGenerationError, generateAgentAvatar } from '@nessie/team-admin'

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
    instructions: 'Give the character a green scarf.',
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
  assert.match(String(promptMessages[0]?.content), /predominantly male audience, default to a woman/)
  assert.match(String(promptMessages[0]?.content), /predominantly female audience, default to a man/)
  assert.match(String(promptMessages[0]?.content), /Only when no predominantly gendered audience is established/)
  assert.match(String(promptMessages[0]?.content), /explicit gender or presentation.*overrides this default/)
  const avatarContext = JSON.parse(String(promptMessages[1]?.content))
  assert.equal(
    avatarContext.agentPurpose,
    'Keep releases predictable and communicate risks early.\n\nAdditional avatar guidance:\nGive the character a green scarf.',
  )
  assert.equal('userRequest' in avatarContext, false)
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

/**
 * What a failure has to say. A portrait that did not get drawn used to report
 * `Ledger image generation failed with HTTP 500.` — a sentence that separates
 * no cause from any other, and the Designer paraphrased even that away. These
 * assert the three facts an operator has no production access to look up:
 * which route was asked, what Ledger answered, and whether it ran out of time.
 */
const failureMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AgentAvatarGenerationError, 'failures keep their own type')
    return error.message
  }
  throw new Error('expected the avatar generation to fail')
}

const failingGeneration = (input: {
  imagePurposeApiId?: string
  imageRequest: Parameters<typeof generateAgentAvatar>[0]['imageRequest']
}) =>
  generateAgentAvatar({
    actorContext,
    agent: { name: 'CTO', role: 'chief technology officer' },
    config: {
      apiKey: 'lk_nessie_deployment_key',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
      ...(input.imagePurposeApiId ? { imagePurposeApiId: input.imagePurposeApiId } : {}),
    },
    fileService: { store: async () => ({ attachment: { id: 'unused' } }) } as never,
    imageRequest: input.imageRequest,
    ledgerIdentity: {
      requestHeaders: async () => ({ 'X-UOA-Delegation': 'signed-uoa-delegation' }),
    },
    modelClient: { chat: async () => 'A portrait prompt.' },
  })

test('an HTTP refusal carries the route, the code and Ledger\'s own words', async () => {
  const message = await failureMessage(failingGeneration({
    imagePurposeApiId: 'pa_dd11af80_25a7',
    imageRequest: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'insufficient_credit',
            message: 'Purpose API has no funded provider key. Bearer lk_nessie_deployment_key rejected.',
          },
        }),
        { status: 403 },
      ),
  }))

  assert.match(message, /HTTP 403/)
  assert.match(message, /Ledger purpose image route pa_dd11af80_25a7/)
  assert.match(message, /code insufficient_credit/)
  assert.match(message, /no funded provider key/)
  // The reason travels; the credential never does, in a log line, a tool
  // output or a 503 body.
  assert.equal(message.includes('lk_nessie_deployment_key'), false)
  assert.equal(message.includes('signed-uoa-delegation'), false)
})

test('a refusal from the direct service route says so, and stays one line long', async () => {
  const message = await failureMessage(failingGeneration({
    imageRequest: async () =>
      new Response(`<html>\n<body>\n${'gateway '.repeat(200)}</body>\n</html>`, { status: 502 }),
  }))

  assert.match(message, /HTTP 502/)
  assert.match(message, /Ledger OpenAI service image route/)
  assert.match(message, /gateway gateway/)
  assert.equal(message.includes('\n'), false, 'an excerpt is flattened to one line')
  assert.ok(message.length < 600, `a body excerpt is truncated, got ${message.length} characters`)
  assert.match(message, /\.\.\.$/)
})

test('running out of time reads as a timeout, not as a refusal', async () => {
  const message = await failureMessage(failingGeneration({
    imagePurposeApiId: 'pa_dd11af80_25a7',
    imageRequest: async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
  }))

  // The timeout a 1024x1024 render behind a two-provider fallback chain is
  // given, named in seconds, so a report says whether to wait longer or look
  // at the route.
  assert.match(message, /timed out after 120s/)
  assert.match(message, /Ledger purpose image route pa_dd11af80_25a7/)
})

test('never arriving reads as a transport failure, not as a timeout', async () => {
  const message = await failureMessage(failingGeneration({
    imageRequest: async () => {
      throw new Error('getaddrinfo ENOTFOUND ledger.unlikeotherai.com')
    },
  }))

  assert.match(message, /could not reach the Ledger OpenAI service image route/)
  assert.match(message, /ENOTFOUND/)
  assert.equal(message.includes('timed out'), false)
})

test('a well-formed response that is not an image names the route it came from', async () => {
  const message = await failureMessage(failingGeneration({
    imagePurposeApiId: 'pa_dd11af80_25a7',
    imageRequest: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  }))

  assert.match(message, /invalid image response from the Ledger purpose image route/)
  assert.match(message, /"data":\[\]/)
})

test('the prompt call and the image call are distinguishable in the error text', async () => {
  const message = await failureMessage(generateAgentAvatar({
    actorContext,
    agent: { name: 'CTO', role: 'chief technology officer' },
    config: {
      apiKey: 'lk_nessie_deployment_key',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
      imagePurposeApiId: 'pa_dd11af80_25a7',
    },
    fileService: { store: async () => ({ attachment: { id: 'unused' } }) } as never,
    imageRequest: async () => new Response('{}', { status: 200 }),
    ledgerIdentity: null,
    modelClient: {
      chat: async () => {
        throw new Error('model gateway unavailable')
      },
    },
  }))

  assert.match(message, /avatar prompt could not be generated: model gateway unavailable/)
  assert.equal(message.includes('image generation'), false)
})
