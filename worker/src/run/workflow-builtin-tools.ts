import { Prisma, type PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  UrlSafetyError,
  WORKFLOW_TOOL_IDS,
  type LedgerIdentityService,
} from '@nessie/runtime'
import {
  parseOrganizationId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { createWorkflowChannelMessage } from '../control/workflow-message-send.js'
import { collectWebFetchResult, collectWebSearchResults, coercePage } from './content-tools.js'
import { HttpFetchError } from './builtin-handlers/index.js'
import { hashJsonValue, summarizeToolInput } from './tool-util.js'

type WorkflowToolExecutionResult = {
  inputSummary: string
  output: Record<string, unknown>
  summary: string
  success: boolean
}

export type WorkflowBuiltinToolRuntimeContext = {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
  organizationId: string
  prisma: PrismaClient
  workflowInstallationId: string
  workflowRunId: string
  workflowStepRunId: string
  // W15: message_send's default target is the installation's channel.
  installationChannelId?: string | null
  // W18: the run's executor dispatch attempt — scopes a state_put writer so a
  // retried step's repeat write is a conflict, while the crashed attempt's
  // repeat is an idempotent no-op.
  workflowRunAttempt?: number
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
  const inputSummary = summarizeToolInput(args)

  if (!WORKFLOW_TOOL_IDS.has(toolName)) {
    return workflowToolFailure(inputSummary, `Unsupported workflow tool: ${toolName}`)
  }

  switch (toolName) {
    case 'web_search': {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return workflowToolFailure(inputSummary, 'Workflow web_search requires query.')
      }

      const actionAgentId = context.actorContext.actionContext.agentId
      const actorAgentId =
        context.actorContext.actor.actorType === 'agent'
          ? context.actorContext.actor.actorId
          : undefined
      const attributedAgentId = actionAgentId ?? actorAgentId
      const result = await collectWebSearchResults(
        query,
        coercePage(args.page),
        {
          attribution: attributionFromActorContext(context.actorContext, {
            agentId: attributedAgentId,
            agentKind: attributedAgentId ? 'shared' : 'system',
            runId: context.workflowRunId,
            systemComponent: 'workflow.web-search',
          }),
          ledgerIdentity: context.ledgerIdentity,
          toolCallId: context.workflowStepRunId,
        },
      )
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
        if (error instanceof HttpFetchError || error instanceof UrlSafetyError) {
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
      // W18 CAS: `expectedVersion` is the version state_get/change_detect
      // returned. A mismatch fails the write; a repeat write from the same
      // writer (stepRun + run attempt) with the same value hash is a no-op
      // success, so a crash between the write and the step-finish never
      // wedges the retry on a permanently stale expectedVersion.
      const hasExpectedVersion = Object.prototype.hasOwnProperty.call(args, 'expectedVersion')
      const expectedVersion =
        typeof args.expectedVersion === 'number' && Number.isInteger(args.expectedVersion)
          ? args.expectedVersion
          : undefined
      if (hasExpectedVersion && expectedVersion === undefined) {
        return workflowToolFailure(
          inputSummary,
          'Workflow state_put expectedVersion must be an integer.',
        )
      }

      const existing = await context.prisma.workflowStateEntry.findUnique({
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
          workflowStepRunId: true,
          writerAttempt: true,
        },
      })

      if (hasExpectedVersion) {
        const currentVersion = existing?.version ?? 0
        const sameWriter =
          existing !== null &&
          existing.workflowStepRunId === context.workflowStepRunId &&
          existing.writerAttempt === context.workflowRunAttempt &&
          existing.version === expectedVersion
        // The hash condition matters: a same-writer repeat carrying the SAME
        // value is the crash-between-write-and-finish replay (no-op success),
        // while the same writer carrying DIFFERENT data is a real conflict —
        // never silently swallowed.
        const sameWriterRepeat = sameWriter && existing?.valueHash === valueHash
        if (!sameWriterRepeat && (sameWriter || currentVersion !== expectedVersion)) {
          return workflowToolFailure(
            inputSummary,
            `Workflow state_put conflict for "${key}": expected version ${expectedVersion}, found ${currentVersion}. Re-read the state and retry.`,
          )
        }
        if (sameWriterRepeat) {
          return {
            inputSummary,
            output: {
              idempotent: true,
              key,
              updatedAt: existing.updatedAt.toISOString(),
              value: existing.value,
              valueHash: existing.valueHash,
              version: existing.version,
            },
            summary: `State "${key}" already written by this attempt.`,
            success: true,
          }
        }
      }

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
          writerAttempt: context.workflowRunAttempt,
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
          writerAttempt: context.workflowRunAttempt,
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
    case 'message_send': {
      const body = typeof args.body === 'string' ? args.body : ''
      if (!body.trim()) {
        return workflowToolFailure(inputSummary, 'Workflow message_send requires body.')
      }

      try {
        // W15: validate + post through the single message-create seam INSIDE
        // one transaction (the W28 lesson). The body reached the tool
        // arguments through the redacted binding resolver, so no tainted ref
        // can be in it.
        const posted = await context.prisma.$transaction((tx) =>
          createWorkflowChannelMessage(tx, {
            actorId: context.actorContext.actor.actorId,
            actorType: context.actorContext.actor.actorType,
            body,
            channelId: typeof args.channelId === 'string' ? args.channelId : undefined,
            installationChannelId: context.installationChannelId,
            organizationId: context.organizationId,
            threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
            workflowRunId: context.workflowRunId,
            workflowStepRunId: context.workflowStepRunId,
          }),
        )
        return {
          inputSummary,
          output: {
            channelId: posted.channelId,
            messageId: posted.messageId,
            threadId: posted.threadId,
          },
          summary: `Posted message to channel ${posted.channelId}.`,
          success: true,
        }
      } catch (error) {
        return workflowToolFailure(
          inputSummary,
          error instanceof Error ? error.message : 'Workflow message_send failed.',
        )
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
