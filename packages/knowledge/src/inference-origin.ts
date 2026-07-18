import type { Prisma, PrismaClient } from '@prisma/client'
import type { KnowledgeInferenceOrigin } from '@nessie/schemas'

const KNOWLEDGE_INDEX_SYSTEM_AGENT_ID =
  '16c58b43-15d0-5c61-8f8b-e3e76d587e50'

type KnowledgeOriginClient =
  | PrismaClient
  | Prisma.TransactionClient

export type PersistedKnowledgeOriginInput = {
  organizationId: string
  pageId: string
  versionId: string
  systemComponent: string
}

export class KnowledgeInferenceOriginError extends Error {
  readonly code = 'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED'

  constructor(input: PersistedKnowledgeOriginInput) {
    super(
      `Knowledge inference requires a persisted user and team origin `
      + `(page ${input.pageId}, version ${input.versionId})`,
    )
    this.name = 'KnowledgeInferenceOriginError'
  }
}

export const resolvePersistedKnowledgeOrigin = async (
  client: KnowledgeOriginClient,
  input: PersistedKnowledgeOriginInput,
): Promise<KnowledgeInferenceOrigin | null> => {
  const version = await client.knowledgePageVersion.findFirst({
    where: {
      id: input.versionId,
      pageId: input.pageId,
      page: { organizationId: input.organizationId },
    },
    select: {
      authorId: true,
      authorType: true,
      page: {
        select: {
          teamId: true,
          userId: true,
        },
      },
    },
  })
  if (!version?.page.teamId) {
    return null
  }

  const userId =
    version.page.userId
    ?? (version.authorType === 'user' ? version.authorId : null)
  if (!userId) {
    return null
  }

  return {
    actorId: version.authorId,
    actorType: version.authorType,
    agentId:
      version.authorType === 'agent'
        ? version.authorId
        : KNOWLEDGE_INDEX_SYSTEM_AGENT_ID,
    requestId: `${input.systemComponent}:${input.versionId}`,
    runId: input.versionId,
    systemComponent:
      version.authorType === 'agent' ? undefined : input.systemComponent,
    teamId: version.page.teamId,
    userId,
  }
}

export const requirePersistedKnowledgeOrigin = async (
  client: KnowledgeOriginClient,
  input: PersistedKnowledgeOriginInput,
): Promise<KnowledgeInferenceOrigin> => {
  const origin = await resolvePersistedKnowledgeOrigin(client, input)
  if (!origin) {
    throw new KnowledgeInferenceOriginError(input)
  }
  return origin
}
