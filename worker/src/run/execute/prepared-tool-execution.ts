import { summarizeToolInputForTool } from '../tool-util.js'
import type { AgenticToolResult } from '../tool-types.js'
import type { ToolAuthorizationDecision } from './tool-authorization-contract.js'

type PreparedTool =
  | {
      approval: {
        approvalId: string
        notice: string
        requiredApproverUserId: string | null
        toolName: string
      }
      inputSummary: string
      kind: 'suspend'
    }
  | {
      execute: () => Promise<AgenticToolResult>
      inputSummary: string
      kind: 'execute'
    }

/** Preserve the ordinary loop result for an approval that has just suspended. */
export const suspendedToolResult = (
  authorization: Extract<ToolAuthorizationDecision, { decision: 'suspend' }>,
): {
  inputSummary: string
  output: string
  pendingApproval: {
    approvalId: string
    notice: string
    requiredApproverUserId: string | null
    toolName: string
  }
  success: false
} => ({
  inputSummary: summarizeToolInputForTool(authorization.approval.toolName, authorization.args),
  output: 'Tool execution is waiting for human approval.',
  pendingApproval: {
    approvalId: authorization.approval.id,
    notice: authorization.approval.notice,
    requiredApproverUserId: authorization.approval.requiredApproverUserId,
    toolName: authorization.approval.toolName,
  },
  success: false,
})

/** Keep approval preflight separate from the final dispatch authorization. */
export const createPreparedToolExecutor = (input: {
  authorize: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    options: { consumeApprovalProof: false },
  ) => Promise<ToolAuthorizationDecision>
  execute: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ) => Promise<AgenticToolResult>
}) => async (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
): Promise<PreparedTool> => {
  const authorization = await input.authorize(toolName, args, toolCallId, {
    consumeApprovalProof: false,
  })
  if (authorization.decision === 'suspend') {
    return {
      approval: {
        approvalId: authorization.approval.id,
        notice: authorization.approval.notice,
        requiredApproverUserId: authorization.approval.requiredApproverUserId,
        toolName: authorization.approval.toolName,
      },
      inputSummary: summarizeToolInputForTool(authorization.approval.toolName, authorization.args),
      kind: 'suspend',
    }
  }
  return {
    execute: async () => authorization.decision === 'deny'
      ? authorization.result
      : input.execute(toolName, args, toolCallId),
    inputSummary: authorization.decision === 'deny'
      ? authorization.result.inputSummary
      : summarizeToolInputForTool(toolName, authorization.args),
    kind: 'execute',
  }
}
