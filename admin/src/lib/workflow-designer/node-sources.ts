import { WORKFLOW_TRIGGER_TYPE_LABELS } from './constants'
import { isRecord, readRecord } from './json'
import type { WorkflowCanvasNodeType } from './types'

export const getDefaultWorkflowTriggerConfig = (
  triggerType: keyof typeof WORKFLOW_TRIGGER_TYPE_LABELS,
): Record<string, unknown> => {
  switch (triggerType) {
    case 'scheduled':
      return {
        cron: '0 * * * *',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        type: triggerType,
      }
    case 'interval':
      return {
        interval_minutes: 60,
        type: triggerType,
      }
    default:
      return {
        type: triggerType,
      }
  }
}

export const getWorkflowRuntimeStepType = (nodeType: WorkflowCanvasNodeType): string =>
  nodeType === 'agent' ? 'agent_task' : nodeType === 'tool' ? 'tool_call' : nodeType

export const getWorkflowCanvasNodeType = (stepType: string): WorkflowCanvasNodeType | null => {
  if (stepType === 'agent' || stepType === 'agent_task') {
    return 'agent'
  }

  if (stepType === 'tool' || stepType === 'tool_call') {
    return 'tool'
  }

  if (stepType === 'trigger') {
    return 'trigger'
  }

  return null
}

export const getWorkflowNodeInitialConfig = (
  nodeType: WorkflowCanvasNodeType,
  source: unknown,
): Record<string, unknown> => {
  if (!isRecord(source)) {
    return {}
  }

  switch (nodeType) {
    case 'agent':
      return {
        agentId: typeof source.id === 'string' ? source.id : undefined,
      }
    case 'tool':
      return {
        toolName: typeof source.id === 'string' ? source.id : undefined,
      }
    case 'trigger':
      if (
        typeof source.type === 'string' &&
        source.type in WORKFLOW_TRIGGER_TYPE_LABELS &&
        !('createdAt' in source)
      ) {
        return getDefaultWorkflowTriggerConfig(
          source.type as keyof typeof WORKFLOW_TRIGGER_TYPE_LABELS,
        )
      }

      return {
        ...readRecord(source.config),
        description: source.description,
        enabled: source.enabled,
        nextRunAt: source.nextRunAt,
        status: source.status,
        targetChannelId: source.targetChannelId,
        targetThreadId: source.targetThreadId,
        type: source.type,
      }
    default:
      return {}
  }
}

export const getWorkflowNodeMeta = (
  nodeType: WorkflowCanvasNodeType,
  source: unknown,
): string | undefined => {
  if (!isRecord(source)) {
    return undefined
  }

  switch (nodeType) {
    case 'agent':
      return typeof source.role === 'string' ? source.role : undefined
    case 'tool':
      return source.safe === false ? 'restricted' : 'safe'
    case 'trigger':
      if (
        typeof source.type === 'string' &&
        source.type in WORKFLOW_TRIGGER_TYPE_LABELS &&
        !('createdAt' in source)
      ) {
        return source.type
      }
      return typeof source.type === 'string' ? source.type : undefined
    default:
      return undefined
  }
}

export const getWorkflowNodeLabel = (
  nodeType: WorkflowCanvasNodeType,
  source: unknown,
): string => {
  if (!isRecord(source)) {
    return nodeType === 'agent' ? 'Untitled agent' : nodeType === 'tool' ? 'Untitled tool' : 'Untitled trigger'
  }

  switch (nodeType) {
    case 'agent':
      return typeof source.name === 'string' && source.name.trim()
        ? source.name
        : 'Untitled agent'
    case 'tool':
      return typeof source.label === 'string' && source.label.trim()
        ? source.label
        : 'Untitled tool'
    case 'trigger':
      return typeof source.name === 'string' && source.name.trim()
        ? source.name
        : typeof source.type === 'string' && source.type.trim()
          ? source.type
          : 'Untitled trigger'
    default:
      return 'Untitled node'
  }
}
