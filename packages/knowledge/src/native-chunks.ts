import { Prisma } from '@prisma/client'
import { chunkKnowledgePageBody } from './chunking.js'

export type ChunkablePage = {
  channelId: string | null
  id: string
  organizationId: string
  privateToAgentId: string | null
  projectId: string
  sensitivityTier: string
  teamId: string | null
  threadId: string | null
  userId: string | null
  visibility: string
}

type ChunkableVersion = {
  body: string | null
  id: string
}

// Returns true when chunk rows were written for this version. Versions are
// append-only, so a version's chunks never change once written: when they
// already exist (e.g. publish re-running on an already-chunked version) this
// is a no-op — deleting and re-inserting would wipe embeddings the
// knowledge.embed worker job has already filled in.
export const replaceKnowledgePageVersionChunks = async (
  tx: Prisma.TransactionClient,
  input: {
    page: ChunkablePage
    version: ChunkableVersion
  },
): Promise<boolean> => {
  const existing = await tx.$queryRaw<Array<{ present: number }>>(Prisma.sql`
    SELECT 1 AS present FROM knowledge_page_chunks
    WHERE version_id = ${input.version.id}::uuid
    LIMIT 1
  `)
  if (existing.length > 0) return false

  const chunks = await chunkKnowledgePageBody(input.version.body)
  if (chunks.length === 0) return false

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO knowledge_page_chunks (
      page_id,
      version_id,
      chunk_index,
      content,
      content_hash,
      start_offset,
      end_offset,
      token_count,
      organization_id,
      project_id,
      team_id,
      channel_id,
      thread_id,
      user_id,
      visibility,
      sensitivity_tier,
      private_to_agent_id,
      created_at,
      updated_at
    )
    VALUES ${Prisma.join(chunks.map((chunk) => Prisma.sql`(
      ${input.page.id}::uuid,
      ${input.version.id}::uuid,
      ${chunk.chunkIndex},
      ${chunk.content},
      ${chunk.contentHash},
      ${chunk.startOffset},
      ${chunk.endOffset},
      ${chunk.tokenCount},
      ${input.page.organizationId}::uuid,
      ${input.page.projectId}::uuid,
      ${input.page.teamId}::uuid,
      ${input.page.channelId}::uuid,
      ${input.page.threadId}::uuid,
      ${input.page.userId}::uuid,
      ${input.page.visibility}::"ThoughtVisibility",
      ${input.page.sensitivityTier}::"SensitivityTier",
      ${input.page.privateToAgentId}::uuid,
      now(),
      now()
    )`))}
  `)
  return true
}

