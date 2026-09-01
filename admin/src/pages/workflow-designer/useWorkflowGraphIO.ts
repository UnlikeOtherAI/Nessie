import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
} from '../../facades/workflows/hooks'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { usePhoneNavigation } from '../../layouts/admin-shell/PhoneNavigationProvider'
import {
  CANVAS_NODE_INSERT_OFFSET,
  CANVAS_NODE_INSERT_STEPS,
  DEFAULT_WORKFLOW_NAME,
} from '../../lib/workflow-designer/constants'
import {
  clearWorkflowDraft,
  loadWorkflowDraft,
  storeWorkflowDraft,
} from '../../lib/workflow-designer/draft-storage'
import {
  buildWorkflowGraph,
  buildWorkflowTriggers,
  parseWorkflowTemplate,
  WorkflowCanvasStructureError,
} from '../../lib/workflow-designer/serialization'
import type { WorkflowPreservedStep } from '../../lib/workflow-designer/serialization'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowDesignerLocationState,
} from '../../lib/workflow-designer/types'

type UseWorkflowGraphIoInput = {
  canvasRef: MutableRefObject<HTMLDivElement | null>
  nextInsertOffsetRef: MutableRefObject<number>
  isDraggingNode: boolean
  connections: WorkflowConnection[]
  setConnections: Dispatch<SetStateAction<WorkflowConnection[]>>
  nodes: WorkflowCanvasNode[]
  setNodes: Dispatch<SetStateAction<WorkflowCanvasNode[]>>
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>
  workflowName: string
  setWorkflowName: Dispatch<SetStateAction<string>>
}

export const useWorkflowGraphIo = ({
  canvasRef,
  nextInsertOffsetRef,
  isDraggingNode,
  connections,
  setConnections,
  nodes,
  setNodes,
  setSelectedNodeId,
  workflowName,
  setWorkflowName,
}: UseWorkflowGraphIoInput) => {
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const location = useLocation()
  const { workflowTemplateId } = useParams<{ workflowTemplateId?: string }>()
  const isOwner = useIsOwner()
  const {
    data: workflowTemplate,
    isLoading: isWorkflowTemplateLoading,
  } = useWorkflowTemplate(workflowTemplateId, isOwner)
  const createWorkflowTemplate = useCreateWorkflowTemplate()
  const updateWorkflowTemplate = useUpdateWorkflowTemplate()

  const hydratedWorkflowIdRef = useRef<string | null>(null)
  // W10: steps the canvas cannot render, kept verbatim and spliced back into
  // the graph at their original position on save.
  const preservedStepsRef = useRef<WorkflowPreservedStep[]>([])
  const lastSavedWorkflowSignatureRef = useRef<string | null>(null)
  const lastStoredDraftSignatureRef = useRef<string | null>(null)
  // Signature of the last graph the server rejected — autosave skips it so a
  // validation error doesn't turn into a request loop; manual save always retries.
  const lastFailedSignatureRef = useRef<string | null>(null)

  const [autoSaveDraft, setAutoSaveDraft] = useState(true)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const workflowDesignerLocationState = useMemo<WorkflowDesignerLocationState>(() => {
    const state = location.state

    if (!state || typeof state !== 'object') {
      return {}
    }

    const candidateState = state as WorkflowDesignerLocationState
    return {
      returnTo:
        typeof candidateState.returnTo === 'string'
          ? candidateState.returnTo
          : undefined,
      returnToState: candidateState.returnToState,
    }
  }, [location.state])

  // The shared smart Back: an explicit return address wins, else a real
  // previous entry is popped, else the list replaces the cold deep link.
  const handleBack = useCallback(() => {
    if (navigation) {
      navigation.back({
        returnTo: workflowDesignerLocationState.returnTo,
        returnToState: workflowDesignerLocationState.returnToState,
        fallback: '/agents/workflows',
      })
      return
    }
    void navigate(workflowDesignerLocationState.returnTo ?? '/agents/workflows', {
      replace: true,
      state: workflowDesignerLocationState.returnToState,
    })
  }, [
    navigate,
    navigation,
    workflowDesignerLocationState.returnTo,
    workflowDesignerLocationState.returnToState,
  ])

  const workflowSignature = useMemo(
    () =>
      JSON.stringify({
        connections,
        nodes,
        workflowName: workflowName.trim(),
      }),
    [connections, nodes, workflowName],
  )

  const hasWorkflowToSave = nodes.length > 0 && workflowName.trim().length > 0
  const isSavingWorkflow =
    createWorkflowTemplate.isPending || updateWorkflowTemplate.isPending
  const hasUnsavedChanges =
    hasWorkflowToSave &&
    workflowSignature !== lastSavedWorkflowSignatureRef.current

  useEffect(() => {
    if (workflowTemplateId) {
      return
    }

    if (hydratedWorkflowIdRef.current === 'draft') {
      return
    }

    hydratedWorkflowIdRef.current = 'draft'

    const draft = loadWorkflowDraft(undefined)
    if (!draft) {
      lastSavedWorkflowSignatureRef.current = null
      lastStoredDraftSignatureRef.current = JSON.stringify({
        connections: [],
        nodes: [],
        workflowName: DEFAULT_WORKFLOW_NAME,
      })
      setSelectedNodeId(null)
      return
    }

    setConnections(draft.connections)
    setNodes(draft.nodes)
    setWorkflowName(draft.workflowName)
    setSelectedNodeId(draft.nodes[0]?.id ?? null)
    nextInsertOffsetRef.current =
      (draft.nodes.length % CANVAS_NODE_INSERT_STEPS) * CANVAS_NODE_INSERT_OFFSET
    lastSavedWorkflowSignatureRef.current = null
    lastStoredDraftSignatureRef.current = JSON.stringify({
      connections: draft.connections,
      nodes: draft.nodes,
      workflowName: draft.workflowName.trim(),
    })
  }, [workflowTemplateId])

  useEffect(() => {
    if (!workflowTemplateId || !workflowTemplate) {
      return
    }

    if (hydratedWorkflowIdRef.current === workflowTemplateId) {
      return
    }

    const parsedWorkflow = parseWorkflowTemplate(
      workflowTemplate.graph,
      workflowTemplate.triggers,
      canvasRef.current,
    )
    preservedStepsRef.current = parsedWorkflow.preservedSteps
    hydratedWorkflowIdRef.current = workflowTemplateId
    setConnections(parsedWorkflow.connections)
    setNodes(parsedWorkflow.nodes)
    setWorkflowName(workflowTemplate.name)
    setSelectedNodeId(parsedWorkflow.nodes[0]?.id ?? null)
    nextInsertOffsetRef.current =
      (parsedWorkflow.nodes.length % CANVAS_NODE_INSERT_STEPS) *
      CANVAS_NODE_INSERT_OFFSET
    lastSavedWorkflowSignatureRef.current = JSON.stringify({
      connections: parsedWorkflow.connections,
      nodes: parsedWorkflow.nodes,
      workflowName: workflowTemplate.name.trim(),
    })
    lastStoredDraftSignatureRef.current = null
    clearWorkflowDraft(workflowTemplateId)
  }, [workflowTemplate, workflowTemplateId])

  const persistWorkflow = useCallback(
    async (mode: 'auto' | 'manual') => {
      if (!hasWorkflowToSave || isSavingWorkflow) {
        return null
      }

      // W11: refuse to save a canvas the runner cannot execute (forks,
      // merges, cycles, disconnected nodes) — locally, before any request.
      let payload
      try {
        payload = {
          graph: buildWorkflowGraph(nodes, connections, preservedStepsRef.current),
          name: workflowName.trim(),
          triggers: buildWorkflowTriggers(nodes, connections),
        }
      } catch (error) {
        if (error instanceof WorkflowCanvasStructureError) {
          lastFailedSignatureRef.current = workflowSignature
          setSaveError(error.message)
          throw error
        }
        throw error
      }

      let savedWorkflow
      try {
        savedWorkflow = workflowTemplateId
          ? await updateWorkflowTemplate.mutateAsync({
              ...payload,
              workflowTemplateId,
            })
          : await createWorkflowTemplate.mutateAsync(payload)
      } catch (error) {
        // Surface server-side validation (400 WORKFLOW_TEMPLATE_INVALID etc.)
        // in the header instead of dying as an unhandled rejection.
        lastFailedSignatureRef.current = workflowSignature
        setSaveError(error instanceof Error ? error.message : 'Failed to save workflow.')
        throw error
      }

      lastFailedSignatureRef.current = null
      setSaveError(null)
      lastSavedWorkflowSignatureRef.current = JSON.stringify({
        connections,
        nodes,
        workflowName: workflowName.trim(),
      })
      lastStoredDraftSignatureRef.current = workflowSignature
      clearWorkflowDraft(workflowTemplateId)
      setSaveMessage(mode === 'auto' ? 'Draft saved' : 'Workflow saved')

      if (!workflowTemplateId) {
        void navigate(`/agents/workflow-designer/${savedWorkflow.id}`, {
          replace: true,
          state: location.state ?? undefined,
        })
      }

      return savedWorkflow
    },
    [
      connections,
      createWorkflowTemplate,
      hasWorkflowToSave,
      isSavingWorkflow,
      navigate,
      nodes,
      updateWorkflowTemplate,
      workflowName,
      workflowSignature,
      workflowTemplateId,
      location.state,
    ],
  )

  useEffect(() => {
    if (!saveMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSaveMessage(null)
    }, 2200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [saveMessage])

  useEffect(() => {
    if (!autoSaveDraft || isDraggingNode) {
      return
    }

    if (!workflowTemplateId) {
      const isMeaningfulDraft =
        nodes.length > 0 || workflowName.trim() !== DEFAULT_WORKFLOW_NAME

      if (!isMeaningfulDraft) {
        clearWorkflowDraft(workflowTemplateId)
        lastStoredDraftSignatureRef.current = workflowSignature
        return
      }

      if (workflowSignature === lastStoredDraftSignatureRef.current) {
        return
      }

      const timeoutId = window.setTimeout(() => {
        storeWorkflowDraft(
          {
            connections,
            nodes,
            workflowName,
          },
          workflowTemplateId,
        )
        lastStoredDraftSignatureRef.current = workflowSignature
        setSaveMessage('Draft cached')
      }, 450)

      return () => {
        window.clearTimeout(timeoutId)
      }
    }

    if (!hasUnsavedChanges) {
      return
    }

    if (workflowSignature === lastFailedSignatureRef.current) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void persistWorkflow('auto').catch(() => undefined)
    }, 700)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    autoSaveDraft,
    connections,
    hasUnsavedChanges,
    isDraggingNode,
    nodes,
    persistWorkflow,
    workflowName,
    workflowSignature,
    workflowTemplateId,
  ])

  return {
    autoSaveDraft,
    setAutoSaveDraft,
    saveError,
    saveMessage,
    workflowTemplateId,
    isWorkflowTemplateLoading,
    hasWorkflowToSave,
    isSavingWorkflow,
    handleBack,
    persistWorkflow,
  }
}
