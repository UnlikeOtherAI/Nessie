import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Prisma, type PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
} from '@nessie/schemas'
import {
  runAuthoredMessageSearchTool,
  runPeopleSearchTool,
  runSendMessageTool,
  runUpdatePreferencesTool,
  runWorkspaceSearchTool,
} from './pa-tools.js'
import {
  runCancelScheduledTaskTool,
  runListScheduledTasksTool,
  runScheduleTaskTool,
} from './schedule-tools.js'
import {
  FileWriteOverwriteError,
  HttpFetchError,
  runFileGlob,
  runFileRead,
  runFileWrite,
  runHttpFetch,
  runWebSearch,
  SandboxViolationError,
} from './builtin-handlers/index.js'
import { assertSafeUrl } from './builtin-handlers/url-safety.js'
import { enqueueRunExecution } from '../queue.js'
import { appendDelegationStep } from './plans.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

type WorkflowToolExecutionResult = {
  inputSummary: string
  output: Record<string, unknown>
  summary: string
  success: boolean
}

const MAX_PREVIEW_LENGTH = 1200
const MAX_TOOL_RESULT_CHARS = 32_000
const MAX_FETCH_RESPONSE_BYTES = 512_000
const FETCH_TIMEOUT_MS = 15_000
const URL_PATTERN = /https?:\/\/[^\s)]+/i
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const docsRoot = resolve(repoRoot, 'docs')
const docsRootPrefix = `${docsRoot}${sep}`
const truncate = (value: string, maxLength = MAX_PREVIEW_LENGTH): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

const truncateToolResult = (output: string): string =>
  output.length > MAX_TOOL_RESULT_CHARS
    ? output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[output truncated]'
    : output

const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(',')}}`
}

const hashJsonValue = (value: unknown): string =>
  createHash('sha256').update(stableJsonStringify(value)).digest('hex')

const workflowToolFailure = (
  inputSummary: string,
  message: string,
): WorkflowToolExecutionResult => ({
  inputSummary,
  output: {
    error: message,
  },
  summary: message,
  success: false,
})

const normalizeSubtaskRole = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'researcher' || normalized === 'builder' || normalized === 'reviewer') {
    return normalized
  }

  return 'assistant'
}

const buildSubtaskSystemPrompt = (input: {
  parentName: string
  parentSystemPrompt: string | null
  role: string
}): string => {
  const roleLabel = input.role === 'assistant' ? 'specialist' : input.role
  const lines = [
    `You are a delegated ${roleLabel} sub-agent working for ${input.parentName}.`,
    'Focus only on the assigned sub-task, use the available tools when needed, and report concrete results back in this thread.',
    'Do not ask the user to restate context already present in the thread, and do not spawn further subtasks.',
  ]

  const parentPrompt = input.parentSystemPrompt?.trim()
  if (parentPrompt) {
    lines.push('', 'Parent agent instructions:', parentPrompt)
  }

  return lines.join('\n')
}

const runSpawnSubtaskTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    role?: unknown
    task?: unknown
  },
): Promise<ToolExecutionResult> => {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (!task) {
    throw new Error('task is required.')
  }

  const role = normalizeSubtaskRole(input.role)
  const parentAgent = await context.prisma.agent.findUnique({
    where: { id: context.agentId },
    select: {
      id: true,
      model: true,
      name: true,
      provider: true,
      systemPrompt: true,
      toolPolicy: true,
    },
  })
  if (!parentAgent) {
    throw new Error('Parent agent not found.')
  }

  const plan = await context.prisma.plan.findFirst({
    where: { runId: context.run.id },
    select: { id: true },
  })

  const child = await context.prisma.$transaction(async (tx) => {
    const childAgent = await tx.agent.create({
      data: {
        agentKind: 'shared',
        delegationMode: 'none',
        model: parentAgent.model,
        name: `${parentAgent.name} ${role} ${randomUUID().slice(0, 8)}`,
        organizationId: context.channel.organizationId,
        parentAgentId: parentAgent.id,
        provider: parentAgent.provider,
        role,
        surfacePolicy: 'shared',
        systemManaged: false,
        systemPrompt: buildSubtaskSystemPrompt({
          parentName: parentAgent.name,
          parentSystemPrompt: parentAgent.systemPrompt,
          role,
        }),
        toolPolicy: (parentAgent.toolPolicy ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true, name: true },
    })

    const planStep = plan
      ? await appendDelegationStep(tx, {
        assignedAgentId: childAgent.id,
        planId: plan.id,
        payload: { role, task },
        title: `${role}: ${task}`,
      })
      : null

    const run = await tx.run.create({
      data: {
        agentId: childAgent.id,
        status: 'pending',
        threadId: context.run.threadId,
      },
      select: { id: true, threadId: true },
    })

    const childTask = await tx.task.create({
      data: {
        agentId: childAgent.id,
        purpose: task.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    await enqueueRunExecution(
      tx,
      {
        actorContext: withActionContext(context.actorContext, {
          agentId: parseAgentId(childAgent.id),
          channelId: parseChannelId(context.channel.id),
          taskId: parseTaskId(childTask.id),
          threadId: parseThreadId(context.run.threadId),
        }),
        agentId: parseAgentId(childAgent.id),
        messageId: context.run.messageId,
        parentPlanId: plan?.id,
        parentPlanStepId: planStep?.stepId,
        promptOverride: task,
        runId: parseRunId(run.id),
        taskId: parseTaskId(childTask.id),
        threadId: parseThreadId(run.threadId),
      },
      `subtask:${context.run.id}:${childAgent.id}`,
    )

    return {
      agentId: childAgent.id,
      agentName: childAgent.name,
      planStepId: planStep?.stepId ?? null,
      runId: run.id,
      taskId: childTask.id,
    }
  })

  await context.realtimeTransport.publishWs(
    [{ kind: 'channel', channelId: parseChannelId(context.channel.id) }],
    {
      data: {
        childId: parseAgentId(child.agentId),
        parentId: parseAgentId(context.agentId),
        taskId: parseTaskId(child.taskId),
        threadId: parseThreadId(context.run.threadId),
      },
      event: 'agent.spawned',
    },
  )

  return {
    inputSummary: task.slice(0, 200),
    outputPreview: [
      `Spawned ${role} sub-agent.`,
      `agentId=${child.agentId} | name="${child.agentName}"`,
      `runId=${child.runId} | taskId=${child.taskId}`,
      child.planStepId ? `planStepId=${child.planStepId}` : 'planStepId=none',
    ].join('\n'),
    toolName: 'spawn_subtask',
  }
}

export type AgenticToolResult = {
  inputSummary: string
  output: string
  success: boolean
}

export type WorkflowBuiltinToolRuntimeContext = {
  organizationId: string
  prisma: PrismaClient
  workflowInstallationId: string
  workflowRunId: string
  workflowStepRunId: string
}

const extractUrl = (prompt: string): string | null => {
  const rawMatch = prompt.match(URL_PATTERN)?.[0]
  if (!rawMatch) {
    return null
  }

  return rawMatch.replace(/[.,!?;:]+$/, '')
}

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const collectMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return collectMarkdownFiles(fullPath)
      }

      return entry.name.endsWith('.md') ? [fullPath] : []
    }),
  )

  return files.flat()
}

const resolveDocsPath = (candidatePath: string): string | null => {
  const resolvedPath = resolve(repoRoot, candidatePath)
  return resolvedPath === docsRoot || resolvedPath.startsWith(docsRootPrefix)
    ? resolvedPath
    : null
}

const coercePage = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const collectWebSearchResults = async (
  query: string,
  page?: number,
): Promise<{
  query: string
  page: number
  answer: string | null
  results: Array<{ title: string; url: string; snippet: string }>
  text: string
}> => {
  const normalizedQuery = query
    .replace(/\b(search|latest|look up|lookup|find on the web|web)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query.trim()

  return runWebSearch(normalizedQuery, { page })
}

const readResponseText = async (
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  if (!response.body) {
    const text = await response.text()
    const encoded = new TextEncoder().encode(text)
    if (encoded.byteLength <= maxBytes) {
      return { text, truncated: false }
    }
    return {
      text: new TextDecoder().decode(encoded.subarray(0, maxBytes)),
      truncated: true,
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let truncated = false

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }

    const value = chunk.value
    bytesRead += value.byteLength

    if (bytesRead > maxBytes) {
      const overflow = bytesRead - maxBytes
      const allowedBytes = Math.max(0, value.byteLength - overflow)
      text += decoder.decode(value.subarray(0, allowedBytes), { stream: true })
      truncated = true
      await reader.cancel()
      break
    }

    text += decoder.decode(value, { stream: true })
  }

  text += decoder.decode()

  return { text, truncated }
}

const collectWebFetchResult = async (
  rawUrl: string,
): Promise<{
  content: string
  contentHash: string
  contentType: string
  text: string
  truncated: boolean
  url: string
}> => {
  const safeUrl = await assertSafeUrl(rawUrl)
  const response = await fetch(safeUrl, {
    headers: {
      'user-agent': 'NessieWorker/0.0.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const contentType = response.headers.get('content-type') ?? 'text/plain'
  const { text: body, truncated: bodyTruncated } = await readResponseText(
    response,
    MAX_FETCH_RESPONSE_BYTES,
  )
  const text = contentType.includes('text/html') ? stripHtml(body) : body
  const truncated = bodyTruncated || text.length > MAX_TOOL_RESULT_CHARS
  const content = truncated ? text.slice(0, MAX_TOOL_RESULT_CHARS) : text

  return {
    content,
    contentHash: hashJsonValue(text),
    contentType,
    text,
    truncated,
    url: safeUrl.toString(),
  }
}

const selectDocumentPath = async (prompt: string): Promise<string | null> => {
  const explicitPathMatch = prompt.match(/\bdocs\/[A-Za-z0-9._/-]+\.md\b/)
  if (explicitPathMatch) {
    return resolveDocsPath(explicitPathMatch[0])
  }

  const files = await collectMarkdownFiles(docsRoot)
  if (files.length === 0) {
    return null
  }

  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)

  const ranked = files
    .map((filePath) => {
      const haystack = filePath.toLowerCase()
      const score = tokens.reduce(
        (current, token) => current + (haystack.includes(token) ? 1 : 0),
        0,
      )

      return { filePath, score }
    })
    .sort((left, right) => right.score - left.score)

  return ranked.find((entry) => entry.score > 0)?.filePath ?? null
}

export const shouldUseDocumentRead = (prompt: string): boolean =>
  /\b(doc|docs|read|spec|phase|architecture|implementation)\b/i.test(prompt) ||
  /\bdocs\/[A-Za-z0-9._/-]+\.md\b/.test(prompt)

export const shouldUseWebSearch = (prompt: string): boolean =>
  /\b(search|latest|look up|lookup|find on the web|web)\b/i.test(prompt)

export const shouldUseWebFetch = (prompt: string): boolean => URL_PATTERN.test(prompt)

const wrapTool = async (
  inputSummary: string,
  fn: () => Promise<{ outputPreview: string }>,
): Promise<AgenticToolResult> => {
  try {
    const result = await fn()
    return {
      inputSummary,
      output: truncateToolResult(result.outputPreview),
      success: true,
    }
  } catch (error) {
    return {
      inputSummary,
      output: 'Tool error: ' + (error instanceof Error ? error.message : String(error)),
      success: false,
    }
  }
}

const BUILTIN_REGISTRY_SCOPE_KEY = 'builtin'

const loadBuiltinTransportConfig = async (
  prisma: PrismaClient,
  organizationId: string,
  toolId: string,
): Promise<unknown> => {
  const entry = await prisma.toolRegistryEntry.findUnique({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId,
        scopeKey: BUILTIN_REGISTRY_SCOPE_KEY,
        toolId,
      },
    },
    select: { transportConfig: true },
  })
  return entry?.transportConfig ?? {}
}

const wrapBuiltinResult = (
  inputSummary: string,
  fn: () => Promise<unknown>,
): Promise<AgenticToolResult> =>
  fn().then(
    (output) => ({
      inputSummary,
      output: truncateToolResult(JSON.stringify(output, null, 2)),
      success: true,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (
        error instanceof SandboxViolationError ||
        error instanceof FileWriteOverwriteError ||
        error instanceof HttpFetchError
      ) {
        return {
          inputSummary,
          output: `${error.name}: ${message}`,
          success: false,
        }
      }
      return {
        inputSummary,
        output: 'Tool error: ' + message,
        success: false,
      }
    },
  )

export const executeBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
): Promise<AgenticToolResult> => {
  const inputSummary = JSON.stringify(args).slice(0, 200)
  switch (toolName) {
    case 'workspace_search':
      return wrapTool(inputSummary, () =>
        runWorkspaceSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'authored_message_search':
      return wrapTool(inputSummary, () =>
        runAuthoredMessageSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'people_search':
      return wrapTool(inputSummary, () =>
        runPeopleSearchTool(context, String(args.query ?? ''), args.limit),
      )
    case 'send_message':
      return wrapTool(inputSummary, () =>
        runSendMessageTool(context, {
          channelId:
            typeof args.channelId === 'string' ? args.channelId : undefined,
          content: String(args.content ?? ''),
          targetUserId:
            typeof args.targetUserId === 'string' ? args.targetUserId : undefined,
          threadId:
            typeof args.threadId === 'string' ? args.threadId : undefined,
        }),
      )
    case 'update_preferences':
      return wrapTool(inputSummary, () =>
        runUpdatePreferencesTool(
          context,
          (typeof args.preferences === 'object' && args.preferences !== null
            ? args.preferences
            : null) as Record<string, unknown> | null,
        ),
      )
    case 'web_search':
      return wrapTool(inputSummary, () =>
        runWebSearchTool(String(args.query ?? ''), coercePage(args.page)),
      )
    case 'web_fetch':
      return wrapTool(inputSummary, () => runWebFetchTool(String(args.url ?? '')))
    case 'schedule_task':
      return wrapTool(inputSummary, () =>
        runScheduleTaskTool(context, {
          instructions: args.instructions,
          name: args.name,
          schedule: args.schedule,
          target: args.target,
        }),
      )
    case 'list_scheduled_tasks':
      return wrapTool(inputSummary, () => runListScheduledTasksTool(context))
    case 'cancel_scheduled_task':
      return wrapTool(inputSummary, () =>
        runCancelScheduledTaskTool(context, { id: args.id, name: args.name }),
      )
    case 'document_read':
      return wrapTool(inputSummary, () => runDocumentReadTool(String(args.query ?? '')))
    case 'spawn_subtask':
      return wrapTool(inputSummary, () =>
        runSpawnSubtaskTool(context, {
          role: args.role,
          task: args.task,
        }),
      )
    case 'http_fetch':
      return wrapBuiltinResult(inputSummary, () => runHttpFetch(args))
    case 'file_read':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_read',
        )
        return runFileRead(args, transportConfig)
      })
    case 'file_write':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_write',
        )
        return runFileWrite(args, transportConfig)
      })
    case 'file_glob':
      return wrapBuiltinResult(inputSummary, async () => {
        const transportConfig = await loadBuiltinTransportConfig(
          context.prisma,
          context.channel.organizationId,
          'file_glob',
        )
        return runFileGlob(args, transportConfig)
      })
    default:
      return { inputSummary, output: 'Unknown tool: ' + toolName, success: false }
  }
}

export const executeWorkflowBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
  context: WorkflowBuiltinToolRuntimeContext,
): Promise<WorkflowToolExecutionResult> => {
  const inputSummary = JSON.stringify(args).slice(0, 200)

  if (!WORKFLOW_TOOL_IDS.has(toolName)) {
    return workflowToolFailure(inputSummary, `Unsupported workflow tool: ${toolName}`)
  }

  switch (toolName) {
    case 'web_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return workflowToolFailure(inputSummary, 'Workflow web_search requires query.')
      }

      const result = await collectWebSearchResults(query, coercePage(args.page))
      return {
        inputSummary,
        output: {
          query: result.query,
          page: result.page,
          answer: result.answer,
          results: result.results,
          text: result.text,
        },
        summary: `Web search completed for "${result.query}".`,
        success: true,
      }
    }
    case 'web_fetch': {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) {
        return workflowToolFailure(inputSummary, 'Workflow web_fetch requires url.')
      }

      let result: Awaited<ReturnType<typeof collectWebFetchResult>>
      try {
        result = await collectWebFetchResult(url)
      } catch (error) {
        if (error instanceof HttpFetchError) {
          return workflowToolFailure(inputSummary, error.message)
        }
        throw error
      }
      return {
        inputSummary,
        output: {
          content: result.content,
          contentHash: result.contentHash,
          contentType: result.contentType,
          text: result.text,
          truncated: result.truncated,
          url: result.url,
        },
        summary: `Fetched ${result.url}.`,
        success: true,
      }
    }
    case 'state_get': {
      const key = typeof args.key === 'string' ? args.key.trim() : ''
      if (!key) {
        return workflowToolFailure(inputSummary, 'Workflow state_get requires key.')
      }

      const entry = await context.prisma.workflowStateEntry.findUnique({
        where: {
          workflowInstallationId_key: {
            key,
            workflowInstallationId: context.workflowInstallationId,
          },
        },
        select: {
          updatedAt: true,
          value: true,
          valueHash: true,
          version: true,
        },
      })

      const fallbackValue = Object.prototype.hasOwnProperty.call(args, 'defaultValue')
        ? (args.defaultValue ?? null)
        : null

      return {
        inputSummary,
        output: {
          found: entry !== null,
          key,
          updatedAt: entry?.updatedAt.toISOString() ?? null,
          value: entry?.value ?? fallbackValue,
          valueHash: entry?.valueHash ?? null,
          version: entry?.version ?? 0,
        },
        summary: entry ? `Loaded state "${key}".` : `No state found for "${key}".`,
        success: true,
      }
    }
    case 'state_put': {
      const key = typeof args.key === 'string' ? args.key.trim() : ''
      if (!key) {
        return workflowToolFailure(inputSummary, 'Workflow state_put requires key.')
      }
      if (!Object.prototype.hasOwnProperty.call(args, 'value')) {
        return workflowToolFailure(inputSummary, 'Workflow state_put requires value.')
      }

      const value = args.value ?? null
      const valueHash = hashJsonValue(value)
      const entry = await context.prisma.workflowStateEntry.upsert({
        where: {
          workflowInstallationId_key: {
            key,
            workflowInstallationId: context.workflowInstallationId,
          },
        },
        create: {
          key,
          organizationId: parseOrganizationId(context.organizationId),
          value: value as Prisma.InputJsonValue,
          valueHash,
          version: 1,
          workflowInstallationId: context.workflowInstallationId,
          workflowRunId: context.workflowRunId,
          workflowStepRunId: context.workflowStepRunId,
        },
        update: {
          organizationId: parseOrganizationId(context.organizationId),
          value: value as Prisma.InputJsonValue,
          valueHash,
          version: {
            increment: 1,
          },
          workflowRunId: context.workflowRunId,
          workflowStepRunId: context.workflowStepRunId,
        },
        select: {
          updatedAt: true,
          value: true,
          valueHash: true,
          version: true,
          key: true,
        },
      })

      return {
        inputSummary,
        output: {
          key: entry.key,
          updatedAt: entry.updatedAt.toISOString(),
          value: entry.value,
          valueHash: entry.valueHash,
          version: entry.version,
        },
        summary: `Stored state "${entry.key}".`,
        success: true,
      }
    }
    case 'change_detect': {
      const key = typeof args.key === 'string' ? args.key.trim() : ''
      if (!key) {
        return workflowToolFailure(inputSummary, 'Workflow change_detect requires key.')
      }
      if (!Object.prototype.hasOwnProperty.call(args, 'value')) {
        return workflowToolFailure(inputSummary, 'Workflow change_detect requires value.')
      }

      const currentValue = args.value ?? null
      const currentHash = hashJsonValue(currentValue)
      const entry = await context.prisma.workflowStateEntry.findUnique({
        where: {
          workflowInstallationId_key: {
            key,
            workflowInstallationId: context.workflowInstallationId,
          },
        },
        select: {
          updatedAt: true,
          value: true,
          valueHash: true,
          version: true,
        },
      })

      const changed = entry ? entry.valueHash !== currentHash : true
      return {
        inputSummary,
        output: {
          changeType: entry ? (changed ? 'updated' : 'unchanged') : 'created',
          changed,
          currentHash,
          currentValue,
          found: entry !== null,
          key,
          previousHash: entry?.valueHash ?? null,
          previousValue: entry?.value ?? null,
          version: entry?.version ?? 0,
        },
        summary: changed ? `Change detected for "${key}".` : `No change detected for "${key}".`,
        success: true,
      }
    }
    default:
      return workflowToolFailure(inputSummary, `Unsupported workflow tool: ${toolName}`)
  }
}

export const runDocumentReadTool = async (prompt: string): Promise<ToolExecutionResult> => {
  const filePath = await selectDocumentPath(prompt)
  if (!filePath) {
    return {
      inputSummary: 'document query',
      outputPreview: 'No matching project documentation file was found.',
      toolName: 'document_read',
    }
  }

  const content = await readFile(filePath, 'utf8')
  return {
    inputSummary: filePath.replace(`${repoRoot}/`, ''),
    outputPreview: truncate(content),
    toolName: 'document_read',
  }
}

export const runWebFetchTool = async (prompt: string): Promise<ToolExecutionResult> => {
  const url = extractUrl(prompt)
  if (!url) {
    return {
      inputSummary: 'no url provided',
      outputPreview: 'No URL was present in the request.',
      toolName: 'web_fetch',
    }
  }

  const result = await collectWebFetchResult(url)

  return {
    inputSummary: result.url,
    outputPreview: truncate(result.text),
    toolName: 'web_fetch',
  }
}

export const runWebSearchTool = async (
  prompt: string,
  page?: number,
): Promise<ToolExecutionResult> => {
  const result = await collectWebSearchResults(prompt, page)

  return {
    inputSummary: result.page > 1 ? `${result.query} (page ${result.page})` : result.query,
    outputPreview: truncate(result.text),
    toolName: 'web_search',
  }
}
