import {
  bindExecutorCandidateBundleInTransaction, resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, ExecutorMcpToolCatalogSchema, TaskSetProcessorSchema } from '@nessie/schemas'
import { buildExecutorToolset, executorToolName } from '../run/executor-toolset.js'
import { currentExecutorToken } from '../run/execute/lifecycle.js'
import type { ExecutionDependencies, RunContext } from '../run/execute/types.js'
import { taskSetJournalStep } from './journal.js'
import type { TaskSetClaim, TaskSetSearchTools } from './processor.js'
import { TaskSetBlocked } from './state.js'

export const taskSetSearchFailure = (output: string): string => {
  try {
    const body = JSON.parse(output) as { code?: string; content?: Array<{ type?: string; text?: string }> }
    if (body.code === 'EXECUTOR_MCP_RESULT_TOO_LARGE') return 'input_too_large'
    const text = body.content?.find((entry) => entry.type === 'text')?.text
    const code = text ? (JSON.parse(text) as { code?: string }).code : undefined
    const known = ['search_credentials_missing', 'search_credentials_rejected', 'search_quota_exhausted',
      'search_result_too_large', 'search_invalid_response']
    if (code && known.includes(code)) return code
  } catch { /* Only structured protocol reason codes are eligible for display. */ }
  return 'processor_search_unavailable'
}

/** Research uses only the selected local processor's approved Ollama server. */
export const buildTaskSetSearchTools = async (
  deps: ExecutionDependencies, claim: TaskSetClaim, context: RunContext,
): Promise<TaskSetSearchTools> => {
  const processor = TaskSetProcessorSchema.parse(claim.set.processor)
  if (processor.provider !== 'local/ollama' || !processor.localInferenceBindingId) {
    throw new TaskSetBlocked('processor_search_unsupported')
  }
  const binding = await deps.prisma.agentLocalInferenceBinding.findUnique({
    where: { id: processor.localInferenceBindingId },
  })
  const host = binding ? await deps.prisma.localInferenceHost.findUnique({ where: { id: binding.hostId } }) : null
  if (!host?.executorId) throw new TaskSetBlocked('processor_search_setup_required')
  const existing = await deps.prisma.executorBinding.findMany({ where: { runId: claim.attempt.runId } })
  if (existing.some((entry) => entry.executorId !== host.executorId)) {
    throw new TaskSetBlocked('processor_search_binding_changed')
  }
  if (existing.length === 0) {
    const actor = AuthorizedActionContextSchema.parse(claim.set.launchOrigin)
    const result = await resolveExecutorAvailabilityCandidates(deps.prisma, actor, {
      agentId: context.agent.id, executorId: host.executorId, operationKeys: ['mcp.tools', 'mcp.call'],
      runId: claim.attempt.runId,
    })
    const candidate = result.candidates.find((entry) => entry.operationKeys.includes('mcp.tools') && entry.operationKeys.includes('mcp.call'))
    if (!candidate) throw new TaskSetBlocked('processor_search_setup_required')
    await deps.prisma.$transaction((tx) => bindExecutorCandidateBundleInTransaction(tx, {
      actorUserId: claim.set.ownerUserId, candidateHandle: candidate.handle,
      operationKeys: ['mcp.tools', 'mcp.call'], runId: claim.attempt.runId,
    }))
  }
  const agent = await deps.prisma.agent.findUniqueOrThrow({
    where: { id: context.agent.id }, select: { toolPolicy: true },
  })
  const toolset = await buildExecutorToolset(deps.prisma, {
    agentId: context.agent.id, agentToolPolicy: agent.toolPolicy as Record<string, boolean> | null,
    encryptionSecret: deps.executorCommandEncryptionSecret,
    organizationId: claim.set.organizationId, runId: claim.attempt.runId,
  })
  if (!toolset.handledNames.has(executorToolName('mcp.tools')) || !toolset.handledNames.has(executorToolName('mcp.call'))) {
    throw new TaskSetBlocked('processor_search_setup_required')
  }
  const fence = currentExecutorToken(claim.attempt.runId)
  if (!fence) throw new TaskSetBlocked('processor_search_fence_missing')
  const listed = await taskSetJournalStep({
    prisma: deps.prisma, claim, fence, sequence: -1, request: { server: 'ollama-search' }, recoverable: false,
    execute: () => toolset.dispatch(executorToolName('mcp.tools'), { server: 'ollama-search' }, `${claim.attempt.id}:search-catalog`),
  })
  if (!listed.success) throw new TaskSetBlocked('processor_search_setup_required')
  const envelope = JSON.parse(listed.output) as { catalog?: unknown }
  const catalog = ExecutorMcpToolCatalogSchema.parse(envelope.catalog)
  const allowed = ['ollama_web_search', 'ollama_web_fetch']
  const tools = catalog.tools.filter((tool) => allowed.includes(tool.name))
  if (tools.length !== 2 || catalog.nextCursor) throw new TaskSetBlocked('processor_search_setup_required')
  return {
    descriptors: tools.map((tool) => ({ toolName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema })),
    call: async (name, args, callId) => {
      if (!allowed.includes(name)) throw new TaskSetBlocked('processor_unapproved_tool')
      const result = await toolset.dispatch(executorToolName('mcp.call'), { server: 'ollama-search', tool: name, arguments: args }, callId)
      if (!result.success) throw new TaskSetBlocked(taskSetSearchFailure(result.output))
      return result.output
    },
  }
}
