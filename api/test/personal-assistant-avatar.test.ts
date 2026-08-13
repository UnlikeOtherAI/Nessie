import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  attemptPersonalAssistantAvatar,
  ensurePersonalAssistantAvatar,
} from '../src/services/personal-assistant-avatar.js'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-pa-avatar' },
  actor: { actorId: '00000000-0000-4000-8000-000000000001', actorType: 'user' },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
}

const personalAssistant = {
  avatarAttachmentId: null,
  id: '00000000-0000-4000-8000-000000000005',
  name: 'Personal Assistant',
  role: 'assistant',
  systemPrompt: null,
}

const dependencies = (prisma: PrismaClient) => ({
  actorContext,
  config: {
    apiKey: 'lk_test',
    baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
  },
  fileService: {
    delete: async () => true,
    store: async () => ({ attachment: { id: 'unused' } }),
  } as never,
  ledgerIdentity: null,
  modelClient: { chat: async () => 'unused' },
  organizationId: actorContext.tenant.organizationId,
  prisma,
})

test('publishes the first original avatar for the Personal Assistant', async () => {
  let generatedFor: Record<string, unknown> | undefined
  let update: Record<string, unknown> | undefined
  const prisma = {
    agent: {
      findFirst: async () => personalAssistant,
      updateMany: async (input: Record<string, unknown>) => {
        update = input
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient

  await ensurePersonalAssistantAvatar({
    ...dependencies(prisma),
    generateAvatar: async (input) => {
      generatedFor = input.agent as Record<string, unknown>
      return {
        avatarAttachmentId: '00000000-0000-4000-8000-000000000006',
        avatarBackgroundColor: '#CFE8F3',
      }
    },
  })

  assert.deepEqual(generatedFor, {
    id: personalAssistant.id,
    name: personalAssistant.name,
    role: personalAssistant.role,
    systemPrompt: 'A private personal AI assistant that helps its owner organise work, plan next steps, and communicate clearly.',
  })
  assert.deepEqual(update, {
    where: {
      avatarAttachmentId: null,
      id: personalAssistant.id,
    },
    data: {
      avatarAttachmentId: '00000000-0000-4000-8000-000000000006',
      avatarBackgroundColor: '#CFE8F3',
    },
  })
})

test('keeps the established Personal Assistant avatar for later users', async () => {
  let generated = false
  const prisma = {
    agent: {
      findFirst: async () => ({
        ...personalAssistant,
        avatarAttachmentId: '00000000-0000-4000-8000-000000000006',
      }),
      updateMany: async () => {
        throw new Error('must not update an existing avatar')
      },
    },
  } as unknown as PrismaClient

  await ensurePersonalAssistantAvatar({
    ...dependencies(prisma),
    generateAvatar: async () => {
      generated = true
      throw new Error('must not generate an existing avatar')
    },
  })

  assert.equal(generated, false)
})

test('removes a race-lost generated attachment', async () => {
  let deleted: { attachmentId: string; organizationId: string; systemComponent: string | null | undefined } | undefined
  const prisma = {
    agent: {
      findFirst: async () => personalAssistant,
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient
  const deps = dependencies(prisma)

  await ensurePersonalAssistantAvatar({
    ...deps,
    fileService: {
      ...deps.fileService,
      delete: async (attachmentId, organizationId, attribution) => {
        deleted = { attachmentId, organizationId, systemComponent: attribution.systemComponent }
        return true
      },
    } as never,
    generateAvatar: async () => ({
      avatarAttachmentId: '00000000-0000-4000-8000-000000000006',
      avatarBackgroundColor: '#CFE8F3',
    }),
  })

  assert.deepEqual(deleted, {
    attachmentId: '00000000-0000-4000-8000-000000000006',
    organizationId: actorContext.tenant.organizationId,
    systemComponent: 'personal-assistant-avatar-image',
  })
})

test('does not block provisioning when avatar generation is temporarily unavailable', async () => {
  const prisma = {
    agent: {
      findFirst: async () => personalAssistant,
      updateMany: async () => {
        throw new Error('must not publish without an image')
      },
    },
  } as unknown as PrismaClient

  const completed = await attemptPersonalAssistantAvatar({
    ...dependencies(prisma),
    modelClient: null,
  })

  assert.equal(completed, false)
})
