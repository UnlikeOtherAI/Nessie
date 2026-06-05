import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
} from '../../facades/workflows/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
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
} from '../../lib/workflow-designer/serialization'
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
  const location = useLocation()
  const { workflowTemplateId } = useParams<{ workflowTemplateId?: string }>()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const {
    data: workflowTemplate,
    isLoading: isWorkflowTemplateLoading,
  } = useWorkflowTemplate(workflowTemplateId, isOwner)
  const createWorkflowTemplate = useCreateWorkflowTemplate()
  const updateWorkflowTemplate = useUpdateWorkflowTemplate()

  const hydratedWorkflowIdRef = useRef<string | null>(null)
  const lastSavedWorkflowSignatureRef = useRef<string | null>(null)
  const lastStoredDraftSignatureRef = useRef<string | null>(null)

  const [autoSaveDraft, setAutoSaveDraft] = useState(true)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

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

  const handleBack = useCallback(() => {
    if (workflowDesignerLocationState.returnTo) {
      void navigate(workflowDesignerLocationState.returnTo, {
        replace: true,
        state: workflowDesignerLocationState.returnToState,
      })
      return
    }

    const historyIndex =
      typeof window.history.state?.idx === 'number'
        ? window.history.state.idx
        : 0

    if (historyIndex > 0) {
      void navigate(-1)
      return
    }

    void navigate('/agents/workflows', { replace: true })
  }, [
    navigate,
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

    const draft = loadWorkflowDraft()
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
    clearWorkflowDraft()
  }, [workflowTemplate, workflowTemplateId])

  const persistWorkflow = useCallback(
    async (mode: 'auto' | 'manual') => {
      if (!hasWorkflowToSave || isSavingWorkflow) {
        return null
      }

      const payload = {
        graph: buildWorkflowGraph(nodes, connections),
        name: workflowName.trim(),
        triggers: buildWorkflowTriggers(nodes, connections),
      }

      const savedWorkflow = workflowTemplateId
        ? await updateWorkflowTemplate.mutateAsync({
            ...payload,
            workflowTemplateId,
          })
        : await createWorkflowTemplate.mutateAsync(payload)

      lastSavedWorkflowSignatureRef.current = JSON.stringify({
        connections,
        nodes,
        workflowName: workflowName.trim(),
      })
      lastStoredDraftSignatureRef.current = workflowSignature
      clearWorkflowDraft()
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
        clearWorkflowDraft()
        lastStoredDraftSignatureRef.current = workflowSignature
        return
      }

      if (workflowSignature === lastStoredDraftSignatureRef.current) {
        return
      }

      const timeoutId = window.setTimeout(() => {
        storeWorkflowDraft({
          connections,
          nodes,
          workflowName,
        })
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

    const timeoutId = window.setTimeout(() => {
      void persistWorkflow('auto')
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
    saveMessage,
    workflowTemplateId,
    isWorkflowTemplateLoading,
    hasWorkflowToSave,
    isSavingWorkflow,
    handleBack,
    persistWorkflow,
  }
}
