import {
  CANVAS_PADDING,
  DEFAULT_WORKFLOW_NAME,
  WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY,
} from './constants'
import { isRecord } from './json'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowDesignerDraft,
} from './types'

export const loadWorkflowDraft = (): WorkflowDesignerDraft | null => {
  try {
    const rawDraft = window.localStorage.getItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
    if (!rawDraft) {
      return null
    }

    const parsedDraft = JSON.parse(rawDraft) as unknown
    if (!isRecord(parsedDraft)) {
      return null
    }

    const workflowName =
      typeof parsedDraft.workflowName === 'string' && parsedDraft.workflowName.trim()
        ? parsedDraft.workflowName
        : DEFAULT_WORKFLOW_NAME

    const nodes = Array.isArray(parsedDraft.nodes)
      ? parsedDraft.nodes.flatMap((entry) => {
          if (!isRecord(entry)) {
            return []
          }

          const type = entry.type
          if (type !== 'agent' && type !== 'tool' && type !== 'trigger') {
            return []
          }

          return [
            {
              id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
              label:
                typeof entry.label === 'string' && entry.label.trim()
                  ? entry.label
                  : 'Untitled node',
              config: isRecord(entry.config) ? entry.config : {},
              meta: typeof entry.meta === 'string' ? entry.meta : undefined,
              sourceId:
                typeof entry.sourceId === 'string' && entry.sourceId.trim()
                  ? entry.sourceId
                  : typeof entry.id === 'string'
                    ? entry.id
                    : crypto.randomUUID(),
              type,
              x: typeof entry.x === 'number' ? entry.x : CANVAS_PADDING,
              y: typeof entry.y === 'number' ? entry.y : CANVAS_PADDING,
            } satisfies WorkflowCanvasNode,
          ]
        })
      : []

    const connections = Array.isArray(parsedDraft.connections)
      ? parsedDraft.connections.flatMap((entry) => {
          if (!isRecord(entry)) {
            return []
          }

          if (
            typeof entry.id !== 'string' ||
            typeof entry.fromNodeId !== 'string' ||
            typeof entry.toNodeId !== 'string'
          ) {
            return []
          }

          return [
            {
              id: entry.id,
              fromNodeId: entry.fromNodeId,
              toNodeId: entry.toNodeId,
            } satisfies WorkflowConnection,
          ]
        })
      : []

    return {
      connections,
      nodes,
      workflowName,
    }
  } catch {
    return null
  }
}

export const storeWorkflowDraft = (draft: WorkflowDesignerDraft) => {
  window.localStorage.setItem(
    WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY,
    JSON.stringify(draft),
  )
}

export const clearWorkflowDraft = () => {
  window.localStorage.removeItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
}
