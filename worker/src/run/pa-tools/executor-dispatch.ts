import {
  runExecutorAgentAccessPrepareTool,
  runExecutorDescriptorReviewPrepareTool,
  runExecutorInspectTool,
  runExecutorLifecyclePrepareTool,
  runExecutorListTool,
  runExecutorPairTool,
  runExecutorPrivateAssignmentPrepareTool,
  runExecutorWorkspacePromotionPrepareTool,
} from './executors.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

type ExecutorToolThunk = () => Promise<ToolExecutionResult>

/** Keep PA-only executor preparation out of the general builtin dispatcher. */
export const executorManagementTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
): ExecutorToolThunk | null => {
  switch (toolName) {
    case 'executor_list':
      return () => runExecutorListTool(context)
    case 'executor_inspect':
      return () => runExecutorInspectTool(context, { executorId: args.executorId })
    case 'executor_pair':
      return () => runExecutorPairTool(context)
    case 'executor_pause':
    case 'executor_drain':
    case 'executor_revoke':
      return () => runExecutorLifecyclePrepareTool(context, {
        action: toolName.replace('executor_', '') as 'pause' | 'drain' | 'revoke',
        executorId: args.executorId,
      })
    case 'executor_descriptor_review_prepare':
      return () => runExecutorDescriptorReviewPrepareTool(context, {
        executorId: args.executorId,
        revision: args.revision,
        status: args.status,
      })
    case 'executor_agent_access_prepare':
      return () => runExecutorAgentAccessPrepareTool(context, {
        agentId: args.agentId,
        executorId: args.executorId,
        operationKey: args.operationKey,
        state: args.state,
      })
    case 'executor_private_assignment_prepare':
      return () => runExecutorPrivateAssignmentPrepareTool(context, {
        action: args.action,
        executorId: args.executorId,
        principalId: args.principalId,
        principalKind: args.principalKind,
        role: args.role,
      })
    case 'executor_workspace_promotion_prepare':
      return () => runExecutorWorkspacePromotionPrepareTool(context, {
        reviewCommandId: args.reviewCommandId,
      })
    default:
      return null
  }
}
