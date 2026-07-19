import type { RunMemoryConsolidateJobPayload } from '@nessie/schemas'

import type {
  CaptureConfig,
  CapturedThought,
  ThoughtMemoryCategory,
  ThoughtMemoryType,
} from './capture.js'
import { captureThought } from './capture.js'
import { parseAndVerifyMemoryConsolidationJobPayload } from './consolidation-origin.js'

const DEFAULT_THREAD_TAIL_LIMIT = 12
const MAX_SEMANTIC_MEMORIES = 4
const MAX_SOURCE_PREVIEW_CHARS = 320

export type ConsolidationRunContext = {
  agent_id: string
  channel_id: string
  finished_at: Date | string | null
  organization_id: string
  project_id: string | null
  run_status: string
  task_purpose: string | null
  task_status: string
  task_title: string | null
  task_project_id: string | null
  team_id: string | null
  thread_id: string
}

export type ConsolidationThreadMessage = {
  agent_id: string | null
  content: string
  created_at: Date | string
  id: string
  role: string
  user_id: string | null
}

export type ConsolidationMemoryCandidate = {
  content: string
  importance: number
  memoryCategory: ThoughtMemoryCategory
  memoryType: ThoughtMemoryType
  sourceMessageIds: string[]
}

export type ConsolidateRunMemoriesInput = RunMemoryConsolidateJobPayload & {
  threadTailLimit?: number
}

export type ConsolidatedRunMemory = {
  thought: CapturedThought
  memoryCategory: ThoughtMemoryCategory
  memoryType: ThoughtMemoryType
}

export type ConsolidateRunMemoriesOutput = {
  candidateCount: number
  captured: ConsolidatedRunMemory[]
  duplicateCount: number
  skippedReason?: string
}

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim()

const truncateText = (value: string, maxChars = MAX_SOURCE_PREVIEW_CHARS): string => {
  const collapsed = collapseWhitespace(value)
  if (collapsed.length <= maxChars) {
    return collapsed
  }

  return `${collapsed.slice(0, maxChars - 3).trimEnd()}...`
}

const sentenceCandidates = (content: string): string[] =>
  collapseWhitespace(content)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/^[-*0-9.)\s]+/, '').trim())
    .filter((sentence) => sentence.length >= 30 && sentence.length <= 280)

const classifySentence = (
  sentence: string,
): Pick<ConsolidationMemoryCandidate, 'importance' | 'memoryCategory'> | null => {
  const lower = sentence.toLowerCase()

  if (/\b(because|due to|rationale|reason|so that|why)\b/.test(lower)) {
    return { importance: 0.78, memoryCategory: 'reason' }
  }

  if (/\b(must|required|requires|cannot|can't|deadline|budget|constraint)\b/.test(lower)) {
    return { importance: 0.8, memoryCategory: 'constraint' }
  }

  if (/\b(prefer|prefers|preference|likes|wants|would rather)\b/.test(lower)) {
    return { importance: 0.76, memoryCategory: 'preference' }
  }

  if (/\b(agreed|decided|goal|implement|plan|ship|use|will)\b/.test(lower)) {
    return { importance: 0.68, memoryCategory: 'intent' }
  }

  if (/\b(are|depends|has|is|runs|supports|uses)\b/.test(lower)) {
    return { importance: 0.58, memoryCategory: 'fact' }
  }

  return null
}

const buildTaskDescription = (run: ConsolidationRunContext): string => {
  const title = run.task_title ? truncateText(run.task_title, 180) : ''
  const purpose = run.task_purpose ? truncateText(run.task_purpose, 220) : ''

  if (title && purpose && title !== purpose) {
    return `${title}: ${purpose}`
  }

  return title || purpose || 'untitled task'
}

const lastMessageByRole = (
  messages: ConsolidationThreadMessage[],
  role: string,
): ConsolidationThreadMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === role) {
      return message
    }
  }

  return null
}

const buildEpisodicCandidate = (
  run: ConsolidationRunContext,
  messages: ConsolidationThreadMessage[],
): ConsolidationMemoryCandidate | null => {
  const userMessage = lastMessageByRole(messages, 'user')
  const assistantMessage = lastMessageByRole(messages, 'assistant')

  if (!userMessage && !assistantMessage) {
    return null
  }

  const parts = [
    `Run completed for ${buildTaskDescription(run)}.`,
    userMessage ? `User asked: ${truncateText(userMessage.content)}.` : null,
    assistantMessage ? `Agent outcome: ${truncateText(assistantMessage.content)}.` : null,
  ].filter((part): part is string => Boolean(part))

  return {
    content: collapseWhitespace(parts.join(' ')),
    importance: 0.64,
    memoryCategory: 'intent',
    memoryType: 'episodic',
    sourceMessageIds: [userMessage?.id, assistantMessage?.id].filter(
      (id): id is string => Boolean(id),
    ),
  }
}

const buildSemanticCandidates = (
  messages: ConsolidationThreadMessage[],
): ConsolidationMemoryCandidate[] => {
  const candidates: ConsolidationMemoryCandidate[] = []

  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'user') {
      continue
    }

    for (const sentence of sentenceCandidates(message.content)) {
      const classification = classifySentence(sentence)
      if (!classification) {
        continue
      }

      candidates.push({
        content: sentence,
        importance: classification.importance,
        memoryCategory: classification.memoryCategory,
        memoryType: 'semantic',
        sourceMessageIds: [message.id],
      })
    }
  }

  return candidates
}

const normalizeCandidateKey = (candidate: ConsolidationMemoryCandidate): string =>
  collapseWhitespace(candidate.content)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')

export const selectConsolidationCandidates = (
  run: ConsolidationRunContext,
  messages: ConsolidationThreadMessage[],
): ConsolidationMemoryCandidate[] => {
  const candidates = [
    buildEpisodicCandidate(run, messages),
    ...buildSemanticCandidates(messages)
      .sort((left, right) => right.importance - left.importance)
      .slice(0, MAX_SEMANTIC_MEMORIES),
  ].filter((candidate): candidate is ConsolidationMemoryCandidate => Boolean(candidate))

  const byKey = new Map<string, ConsolidationMemoryCandidate>()
  for (const candidate of candidates) {
    const key = normalizeCandidateKey(candidate)
    if (!key || byKey.has(key)) {
      continue
    }
    byKey.set(key, candidate)
  }

  return [...byKey.values()]
}

const loadRunContext = async (
  input: ConsolidateRunMemoriesInput,
  config: CaptureConfig,
): Promise<ConsolidationRunContext | null> => {
  const result = await config.pool.query(
    `SELECT
       r.agent_id,
       r.thread_id,
       r.status::text AS run_status,
       r.finished_at,
       task.status::text AS task_status,
       task.title AS task_title,
       task.purpose AS task_purpose,
       task.project_id AS task_project_id,
       channel.id AS channel_id,
       channel.organization_id,
       channel.team_id,
       team.project_id
     FROM runs AS r
     JOIN tasks AS task
       ON task.id = $2::uuid
      AND task.run_id = r.id
     JOIN threads AS thread
       ON thread.id = r.thread_id
     JOIN channels AS channel
       ON channel.id = thread.channel_id
     JOIN teams AS team
       ON team.id = channel.team_id
     WHERE r.id = $1::uuid
     LIMIT 1`,
    [input.runId, input.taskId],
  )

  return result.rows[0] as ConsolidationRunContext | undefined ?? null
}

const loadThreadTail = async (
  run: ConsolidationRunContext,
  limit: number,
  config: CaptureConfig,
): Promise<ConsolidationThreadMessage[]> => {
  const result = await config.pool.query(
    `SELECT id, role::text, content, user_id, agent_id, created_at
     FROM messages
     WHERE thread_id = $1::uuid
       AND created_at <= COALESCE($2::timestamptz, now())
     ORDER BY created_at DESC
     LIMIT $3`,
    [run.thread_id, run.finished_at, limit],
  )

  return (result.rows as ConsolidationThreadMessage[]).reverse()
}

export const consolidateRunMemories = async (
  input: ConsolidateRunMemoriesInput,
  config: CaptureConfig,
): Promise<ConsolidateRunMemoriesOutput> => {
  const payload = parseAndVerifyMemoryConsolidationJobPayload(input)
  const { origin, source } = payload
  const run = await loadRunContext(payload, config)
  if (!run) {
    return { candidateCount: 0, captured: [], duplicateCount: 0, skippedReason: 'missing_run' }
  }

  if (run.run_status !== 'completed') {
    return { candidateCount: 0, captured: [], duplicateCount: 0, skippedReason: 'run_not_completed' }
  }
  if (run.organization_id !== source.organizationId) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'source_organization_mismatch',
    }
  }
  if (run.agent_id !== source.agentId) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'source_agent_mismatch',
    }
  }
  if (run.thread_id !== source.threadId) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'source_thread_mismatch',
    }
  }
  if (run.channel_id !== source.channelId) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'source_channel_mismatch',
    }
  }
  if (
    run.task_project_id
    && run.task_project_id !== source.projectId
  ) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'source_project_mismatch',
    }
  }
  if (!run.team_id) {
    return {
      candidateCount: 0,
      captured: [],
      duplicateCount: 0,
      skippedReason: 'missing_memory_scope',
    }
  }

  const messages = await loadThreadTail(
    run,
    input.threadTailLimit ?? DEFAULT_THREAD_TAIL_LIMIT,
    config,
  )
  const candidates = selectConsolidationCandidates(run, messages)
  const captured: ConsolidatedRunMemory[] = []
  let duplicateCount = 0

  for (const candidate of candidates) {
    const thought = await captureThought(
      {
        audienceId: run.channel_id,
        audienceType: 'channel',
        channelId: run.channel_id,
        content: candidate.content,
        importance: candidate.importance,
        memoryCategory: candidate.memoryCategory,
        memoryType: candidate.memoryType,
        metadata: {
          memory_origin: 'post_run_consolidation',
          source_message_ids: candidate.sourceMessageIds,
          source_run_id: payload.runId,
          source_task_id: payload.taskId,
          source_thread_id: run.thread_id,
        },
        inferenceAttribution: origin,
        organizationId: run.organization_id,
        ownerId: run.agent_id,
        ownerType: 'agent',
        projectId: run.project_id ?? undefined,
        teamId: run.team_id,
        threadId: run.thread_id,
        visibility: 'channel',
      },
      config,
    )

    if (thought.isDuplicate) {
      duplicateCount += 1
    }

    captured.push({
      memoryCategory: candidate.memoryCategory,
      memoryType: candidate.memoryType,
      thought,
    })
  }

  return {
    candidateCount: candidates.length,
    captured,
    duplicateCount,
  }
}
