import { completeLedgerAttribution } from '@nessie/runtime'
import {
  MemoryConsolidationInferenceOriginSchema,
  RunMemoryConsolidateJobPayloadSchema,
  type MemoryConsolidationInferenceOrigin,
  type MemoryConsolidationSource,
  type RunMemoryConsolidateJobPayload,
} from '@nessie/schemas'

const SYSTEM_COMPONENT = 'memory-consolidation'

const buildRequestId = (runId: string): string =>
  `${SYSTEM_COMPONENT}:${runId}`

export class MemoryConsolidationIdentityError extends Error {
  readonly code = 'MEMORY_CONSOLIDATION_SYSTEM_IDENTITY_MISMATCH'

  constructor(fields: string[]) {
    super(
      `Memory consolidation system identity does not match its source: ${fields.join(', ')}`,
    )
    this.name = 'MemoryConsolidationIdentityError'
  }
}

export const deriveMemoryConsolidationInferenceOrigin = (input: {
  runId: string
  source: MemoryConsolidationSource
}): MemoryConsolidationInferenceOrigin => {
  const requestId = buildRequestId(input.runId)
  const completed = completeLedgerAttribution({
    actorId: input.source.userId,
    actorType: 'system',
    agentId: null,
    agentKind: 'system',
    channelId: input.source.channelId,
    organizationId: input.source.organizationId,
    ...(input.source.projectId ? { projectId: input.source.projectId } : {}),
    requestId,
    runId: null,
    systemComponent: SYSTEM_COMPONENT,
    taskId: input.source.taskId,
    teamId: input.source.teamId,
    threadId: input.source.threadId,
    toolCallId: `${requestId}:capture`,
    userId: input.source.userId,
  })

  return MemoryConsolidationInferenceOriginSchema.parse({
    actorId: completed.agentId,
    actorType: 'system',
    agentId: completed.agentId,
    agentKind: 'system',
    channelId: input.source.channelId,
    organizationId: input.source.organizationId,
    ...(input.source.projectId ? { projectId: input.source.projectId } : {}),
    requestId,
    runId: completed.runId,
    systemComponent: SYSTEM_COMPONENT,
    taskId: input.source.taskId,
    teamId: input.source.teamId,
    threadId: input.source.threadId,
    toolCallId: `${requestId}:capture`,
    userId: input.source.userId,
  })
}

export const parseAndVerifyMemoryConsolidationJobPayload = (
  payload: unknown,
): RunMemoryConsolidateJobPayload => {
  const parsed = RunMemoryConsolidateJobPayloadSchema.parse(payload)
  const expected = deriveMemoryConsolidationInferenceOrigin({
    runId: parsed.runId,
    source: parsed.source,
  })
  const mismatches = (['actorId', 'agentId', 'runId'] as const)
    .filter((field) => parsed.origin[field] !== expected[field])

  if (mismatches.length > 0) {
    throw new MemoryConsolidationIdentityError(mismatches)
  }

  return parsed
}
