import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type {
  FileService,
  LedgerIdentityService,
  ModelClient,
} from '@nessie/runtime'
import { attributionFromActorContext } from '@nessie/runtime'

import {
  AgentAvatarGenerationError,
  generateAgentAvatar,
} from './agent-avatar-generation.js'

const PERSONAL_ASSISTANT_AVATAR_PURPOSE = [
  'A private personal AI assistant that helps its owner organise work,',
  'plan next steps, and communicate clearly.',
].join(' ')

type PersonalAssistantAvatarAgent = {
  avatarAttachmentId: string | null
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

type GenerateAvatar = typeof generateAgentAvatar

/**
 * Publish the first avatar for the organization-managed Personal Assistant.
 * Its private DM is per user, but its underlying agent is deliberately shared
 * per organization, so an existing image is never regenerated for later users.
 */
export const ensurePersonalAssistantAvatar = async (input: {
  actorContext: AuthorizedActionContext
  config: Pick<ModelConfig, 'apiKey' | 'baseUrl'>
  fileService: Pick<FileService, 'delete' | 'store'>
  generateAvatar?: GenerateAvatar
  ledgerIdentity: LedgerIdentityService | null
  modelClient: Pick<ModelClient, 'chat'> | null
  organizationId: string
  prisma: PrismaClient
}): Promise<void> => {
  const agent = await input.prisma.agent.findFirst({
    where: {
      agentKind: 'personal_assistant',
      organizationId: input.organizationId,
      systemManaged: true,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      avatarAttachmentId: true,
      id: true,
      name: true,
      role: true,
      systemPrompt: true,
    },
  }) as PersonalAssistantAvatarAgent | null

  if (!agent || agent.avatarAttachmentId) {
    return
  }
  if (!input.modelClient) {
    throw new AgentAvatarGenerationError('The model service is not configured.')
  }

  const generated = await (input.generateAvatar ?? generateAgentAvatar)({
    actorContext: input.actorContext,
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      systemPrompt: agent.systemPrompt ?? PERSONAL_ASSISTANT_AVATAR_PURPOSE,
    },
    config: input.config,
    fileService: input.fileService,
    ledgerIdentity: input.ledgerIdentity,
    modelClient: input.modelClient,
  })

  const published = await input.prisma.agent.updateMany({
    where: {
      avatarAttachmentId: null,
      id: agent.id,
    },
    data: {
      avatarAttachmentId: generated.avatarAttachmentId,
      avatarBackgroundColor: generated.avatarBackgroundColor,
    },
  })
  if (published.count > 0) {
    return
  }

  // Another simultaneous bootstrap already published its own original image.
  // Dispose of this unreferenced attachment with the same scoped attribution.
  await input.fileService.delete(
    generated.avatarAttachmentId,
    input.actorContext.tenant.organizationId,
    attributionFromActorContext(input.actorContext, {
      agentId: agent.id,
      agentKind: 'personal_assistant',
      systemComponent: 'personal-assistant-avatar-image',
    }),
  )
}

/**
 * A profile image must never prevent account provisioning or a sign-in. A later
 * sign-in or the PA bootstrap route retries while the agent has no avatar.
 */
export const attemptPersonalAssistantAvatar = async (
  input: Parameters<typeof ensurePersonalAssistantAvatar>[0],
): Promise<boolean> => {
  try {
    await ensurePersonalAssistantAvatar(input)
    return true
  } catch (error) {
    if (!(error instanceof AgentAvatarGenerationError)) {
      throw error
    }
    console.error('[personal-assistant] Avatar generation will retry:', error.message)
    return false
  }
}
