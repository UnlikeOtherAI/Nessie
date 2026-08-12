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

// W14: drafts are keyed per template — editing template A then opening
// "new workflow" (or template B) must not hydrate A's nodes. The legacy
// global key is imported once into the new-workflow slot and then removed,
// so in-flight drafts from before the scoping are not destroyed.
export const workflowDraftStorageKey = (workflowTemplateId?: string) =>
  `${WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY}.${workflowTemplateId ?? 'new'}`

export const loadWorkflowDraft = (
  workflowTemplateId?: string,
): WorkflowDesignerDraft | null => {
  try {
    const storageKey = workflowDraftStorageKey(workflowTemplateId)
    let rawDraft = window.localStorage.getItem(storageKey)

    if (!rawDraft) {
      // The legacy global draft belonged to the new-workflow flow (template
      // drafts were not stored at all), so it migrates into the 'new' slot
      // whichever load runs first — never into a template's slot.
      const legacyDraft = window.localStorage.getItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
      if (legacyDraft) {
        window.localStorage.setItem(
          workflowDraftStorageKey(undefined),
          legacyDraft,
        )
        window.localStorage.removeItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
        if (!workflowTemplateId) {
          rawDraft = legacyDraft
        }
      }
    }

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

export const storeWorkflowDraft = (
  draft: WorkflowDesignerDraft,
  workflowTemplateId?: string,
) => {
  window.localStorage.setItem(
    workflowDraftStorageKey(workflowTemplateId),
    JSON.stringify(draft),
  )
}

export const clearWorkflowDraft = (workflowTemplateId?: string) => {
  window.localStorage.removeItem(workflowDraftStorageKey(workflowTemplateId))
}
