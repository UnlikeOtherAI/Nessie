import { Prisma, type PrismaClient } from '@prisma/client'
import { taskContentHash, taskSearchContent } from '@nessie/db'
import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import {
  EMBEDDING_DIMENSIONS,
  redactDetectedSecrets,
  type TaskEmbedJobPayload,
} from '@nessie/schemas'

type TaskEmbedDeps = {
  ledgerSigningConfigured?: boolean
  modelClient: Pick<ModelClient, 'embedMany' | 'embeddingModel'>
  prisma: PrismaClient
}

export const TASK_EMBED_IDENTITY_UNAVAILABLE = 'uoa_identity_unavailable'

type TaskSource = {
  agentId: string | null
  createdByUserId: string | null
  detail: string | null
  projectId: string | null
  purpose: string | null
  title: string | null
  project: { teamId: string | null } | null
}

type ProjectionState = {
  error: string | null
  status: 'failed' | 'indexed' | 'skipped'
  vector: number[] | null
}

const attributionForTask = (
  task: TaskSource,
  payload: TaskEmbedJobPayload,
): LedgerAttribution => {
  const userId = payload.origin?.userId ?? task.createdByUserId
  return {
    actorId: task.agentId ?? userId ?? 'task-indexer',
    actorType: task.agentId ? 'agent' : userId ? 'user' : 'system',
    agentId: task.agentId,
    organizationId: payload.organizationId,
    projectId: task.projectId,
    requestId: `task-index:${payload.taskId}`,
    systemComponent: 'task-index',
    taskId: payload.taskId,
    teamId: task.project?.teamId ?? null,
    userId,
    ...(payload.origin ? { uoaIdentity: payload.origin.uoaIdentity } : {}),
  }
}

const writeProjectionState = async (
  prisma: PrismaClient,
  payload: TaskEmbedJobPayload,
  state: ProjectionState,
): Promise<void> => {
  const vector = state.vector ? `[${state.vector.join(',')}]` : null
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO task_embeddings (
      id, task_id, content_hash, embedding, embedding_model, dims, status,
      last_error, created_at, updated_at
    )
    SELECT gen_random_uuid(), ${payload.taskId}::uuid, ${payload.contentHash},
           ${vector}::vector, ${payload.embeddingModel}, ${EMBEDDING_DIMENSIONS},
           ${state.status}, ${state.error}, now(), now()
    WHERE EXISTS (
      SELECT 1 FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${payload.taskId}::uuid
        AND t.organization_id = ${payload.organizationId}::uuid
        AND t.project_id IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.channel_root = false
        AND encode(digest(concat_ws(E'\n\n',
          NULLIF(coalesce(t.title, ''), ''),
          NULLIF(coalesce(t.purpose, ''), ''),
          NULLIF(coalesce(t.detail, ''), '')
        ), 'sha256'), 'hex') = ${payload.contentHash}
    )
    ON CONFLICT (task_id) DO UPDATE SET
      content_hash = EXCLUDED.content_hash,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      status = EXCLUDED.status,
      last_error = EXCLUDED.last_error,
      updated_at = now()
  `)
}

/** Embed one exact canonical ticket revision; stale jobs write nothing. */
export const executeTaskEmbedJob = async (
  deps: TaskEmbedDeps,
  payload: TaskEmbedJobPayload,
): Promise<void> => {
  if (payload.embeddingModel !== deps.modelClient.embeddingModel) return
  const task = await deps.prisma.task.findFirst({
    where: {
      id: payload.taskId,
      organizationId: payload.organizationId,
      projectId: { not: null },
      project: { channelRoot: false, deletedAt: null },
    },
    select: {
      agentId: true,
      createdByUserId: true,
      detail: true,
      projectId: true,
      purpose: true,
      title: true,
      project: { select: { teamId: true } },
    },
  })
  if (!task || taskContentHash(task) !== payload.contentHash) return

  const content = redactDetectedSecrets(taskSearchContent(task)).trim()
  if (!content) {
    await writeProjectionState(deps.prisma, payload, {
      error: null,
      status: 'skipped',
      vector: null,
    })
    return
  }
  if (deps.ledgerSigningConfigured && !payload.origin) {
    await writeProjectionState(deps.prisma, payload, {
      error: TASK_EMBED_IDENTITY_UNAVAILABLE,
      status: 'skipped',
      vector: null,
    })
    return
  }

  let vector: number[] | undefined
  try {
    [vector] = await deps.modelClient.embedMany([content], {
      usage: attributionForTask(task, payload),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : 'embedding request failed'
    await writeProjectionState(deps.prisma, payload, {
      error: detail,
      status: 'failed',
      vector: null,
    })
    throw error
  }
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    const detail = `embedding dimensions ${vector?.length ?? 'missing'}; expected ${EMBEDDING_DIMENSIONS}`
    await writeProjectionState(deps.prisma, payload, {
      error: detail,
      status: 'failed',
      vector: null,
    })
    throw new Error(detail)
  }
  await writeProjectionState(deps.prisma, payload, {
    error: null,
    status: 'indexed',
    vector,
  })
}
