import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { WorkflowCanvas } from '../components/features/workflow-designer/WorkflowCanvas'
import { WorkflowDesignerHeader } from '../components/features/workflow-designer/WorkflowDesignerHeader'
import { WorkflowNodeInspector } from '../components/features/workflow-designer/WorkflowNodeInspector'
import { WorkflowToolbar } from '../components/features/workflow-designer/WorkflowToolbar'
import type { ToolbarMenuItem } from '../lib/workflow-designer/types'
import { useWorkflowCanvasInteractions } from './workflow-designer/useWorkflowCanvasInteractions'
import { useWorkflowDesignerState } from './workflow-designer/useWorkflowDesignerState'
import { useWorkflowGraphIo } from './workflow-designer/useWorkflowGraphIO'
import { useWorkflowTestRun } from './workflow-designer/useWorkflowTestRun'

const normalizeReturnTo = (pathname: string, search: string, hash: string) =>
  `${pathname}${search}${hash}`

export const WorkflowDesignerPage = () => {
  const navigate = useNavigate()
  const location = useLocation()

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const nextInsertOffsetRef = useRef(0)

  const returnTo = normalizeReturnTo(
    location.pathname,
    location.search,
    location.hash,
  )

  const state = useWorkflowDesignerState({
    canvasRef,
    returnTo,
    nextInsertOffsetRef,
  })

  const canvas = useWorkflowCanvasInteractions({
    canvasRef,
    connections: state.connections,
    setConnections: state.setConnections,
    nodes: state.nodes,
    setNodes: state.setNodes,
    setSelectedNodeId: state.setSelectedNodeId,
  })

  const graphIo = useWorkflowGraphIo({
    canvasRef,
    nextInsertOffsetRef,
    isDraggingNode: canvas.isDraggingNode,
    connections: state.connections,
    setConnections: state.setConnections,
    nodes: state.nodes,
    setNodes: state.setNodes,
    setSelectedNodeId: state.setSelectedNodeId,
    workflowName: state.workflowName,
    setWorkflowName: state.setWorkflowName,
  })

  const testRun = useWorkflowTestRun({
    persistWorkflow: graphIo.persistWorkflow,
    workflowTemplateId: graphIo.workflowTemplateId,
  })

  const handleMenuItemClick = (item: ToolbarMenuItem) => {
    if (item.nodeType) {
      state.addNodeFromItem(item)
      return
    }

    if (!item.to) {
      return
    }

    void navigate(item.to, item.state ? { state: item.state } : undefined)
  }

  return (
    <div
      aria-label="Workflow Designer"
      className="flex h-full w-full flex-col bg-[color:var(--surface-inverse)]"
    >
      <WorkflowDesignerHeader
        workflowName={state.workflowName}
        onWorkflowNameChange={state.setWorkflowName}
        isWorkflowTemplateLoading={graphIo.isWorkflowTemplateLoading}
        saveError={graphIo.saveError ?? testRun.error}
        saveMessage={graphIo.saveMessage}
        workflowTemplateId={graphIo.workflowTemplateId}
        autoSaveDraft={graphIo.autoSaveDraft}
        onToggleAutoSaveDraft={() =>
          graphIo.setAutoSaveDraft((currentValue) => !currentValue)
        }
        hasWorkflowToSave={graphIo.hasWorkflowToSave}
        isSavingWorkflow={graphIo.isSavingWorkflow}
        onBack={graphIo.handleBack}
        onSave={() => {
          void graphIo.persistWorkflow('manual').catch(() => undefined)
        }}
        onTestRun={() => {
          void testRun.startTestRun()
        }}
        testRunState={testRun.state}
      />

      <WorkflowToolbar
        onMenuItemClick={handleMenuItemClick}
        toolbarActions={state.toolbarActions}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkflowCanvas
          canvasRef={canvasRef}
          connections={state.connections}
          connectionLayouts={canvas.connectionLayouts}
          draftConnection={canvas.draftConnection}
          hoveredHandle={canvas.hoveredHandle}
          hoveredConnectionId={canvas.hoveredConnectionId}
          setHoveredConnectionId={canvas.setHoveredConnectionId}
          invalidDraftTarget={canvas.invalidDraftTarget}
          nodes={state.nodes}
          selectedNodeId={state.selectedNodeId}
          stepRunsByNodeId={testRun.stepRunsByNodeId}
          dragStateRef={canvas.dragStateRef}
          onClearSelection={() => state.setSelectedNodeId(null)}
          onNodePointerDown={canvas.handleNodePointerDown}
          onConnectionStart={canvas.handleConnectionStart}
          onConnectionDelete={canvas.handleConnectionDelete}
        />

        <WorkflowNodeInspector
          channels={state.channels}
          selectedNode={state.selectedNode}
          selectedNodeSource={state.selectedNodeSource}
          selectedNodeSourceOptions={state.selectedNodeSourceOptions}
          selectedNodeConfigDraft={state.selectedNodeConfigDraft}
          selectedNodeConfigError={state.selectedNodeConfigError}
          selectedNodeStepRun={
            state.selectedNodeId
              ? testRun.stepRunsByNodeId.get(state.selectedNodeId)
              : undefined
          }
          selectedNodeUpstreamSteps={state.selectedNodeUpstreamSteps}
          onLabelChange={state.handleSelectedNodeLabelChange}
          onSourceChange={state.handleSelectedNodeSourceChange}
          onConfigChange={state.handleSelectedNodeConfigChange}
          onConfigPatch={state.handleSelectedNodeConfigPatch}
        />
      </div>
    </div>
  )
}
