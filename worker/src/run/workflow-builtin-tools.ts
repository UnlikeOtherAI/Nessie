import { Prisma, type PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import { parseOrganizationId } from '@nessie/schemas'
import { collectWebFetchResult, collectWebSearchResults, coercePage } from './content-tools.js'
import { HttpFetchError } from './builtin-handlers/index.js'
import { hashJsonValue } from './tool-util.js'

type WorkflowToolExecutionResult = {
  inputSummary: string
  output: Record<string, unknown>
  summary: string
  success: boolean
}

export type WorkflowBuiltinToolRuntimeContext = {
  organizationId: string
  prisma: PrismaClient
  workflowInstallationId: string
  workflowRunId: string
  workflowStepRunId: string
}

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
