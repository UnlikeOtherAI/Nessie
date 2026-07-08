import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  faBolt,
  faRobot,
  faScrewdriverWrench,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  CANVAS_NODE_HANDLE_Y,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  nodeThemes,
} from '../../../lib/workflow-designer/constants'
import type {
  WorkflowCanvasNode as WorkflowCanvasNodeType,
  WorkflowConnection,
  WorkflowHoveredHandle,
} from '../../../lib/workflow-designer/types'
import type { WorkflowStepRunRecord } from '../../../lib/api-client'

// Whiteboard-exception palette (see constants.ts) for live run states.
const STEP_RUN_COLORS: Record<WorkflowStepRunRecord['status'], string> = {
  blocked: '#d97706',
  completed: '#2e7d32',
  failed: '#c62828',
  pending: '#8b7a93',
  running: '#d97706',
  skipped: '#8b7a93',
}

type WorkflowCanvasNodeProps = {
  node: WorkflowCanvasNodeType
  connections: WorkflowConnection[]
  hoveredHandle: WorkflowHoveredHandle | null
  invalidDraftTarget: WorkflowHoveredHandle | null
  selectedNodeId: string | null
  stepRun?: WorkflowStepRunRecord
  isDragging: boolean
  onNodePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    nodeId: string,
  ) => void
  onConnectionStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
    startHandleKind: 'input' | 'output',
  ) => void
}

export const WorkflowCanvasNode = ({
  node,
  connections,
  hoveredHandle,
  invalidDraftTarget,
  selectedNodeId,
  stepRun,
  isDragging,
  onNodePointerDown,
  onConnectionStart,
}: WorkflowCanvasNodeProps) => {
  const theme = nodeThemes[node.type]
  const hasIncomingConnection = connections.some(
    (connection) => connection.toNodeId === node.id,
  )
  const hasOutgoingConnection = connections.some(
    (connection) => connection.fromNodeId === node.id,
  )
  const isHoveredInput =
    hoveredHandle?.nodeId === node.id && hoveredHandle.kind === 'input'
  const isHoveredOutput =
    hoveredHandle?.nodeId === node.id && hoveredHandle.kind === 'output'
  const isInvalidInputTarget =
    invalidDraftTarget?.nodeId === node.id &&
    invalidDraftTarget.kind === 'input'
  const isInvalidOutputTarget =
    invalidDraftTarget?.nodeId === node.id &&
    invalidDraftTarget.kind === 'output'
  const isSelected = selectedNodeId === node.id

  return (
    <div
      className={[
        'absolute z-20 cursor-grab select-none rounded-2xl border bg-[var(--surface-inverse)] shadow-[0_18px_40px_var(--scrim)] active:cursor-grabbing',
        isSelected ? 'ring-2 ring-[var(--accent-hover)] ring-offset-2 ring-offset-[var(--surface-inverse)]' : '',
        isDragging ? 'z-30' : '',
      ].join(' ')}
      onPointerDown={(event) => onNodePointerDown(event, node.id)}
      style={{
        backgroundColor: theme.fill,
        borderColor: theme.border,
        height: CANVAS_NODE_HEIGHT,
        left: node.x,
        top: node.y,
        userSelect: 'none',
        width: CANVAS_NODE_WIDTH,
      }}
    >
      {node.type !== 'trigger' ? (
        <button
          aria-label={`Connect into ${node.label}`}
          className="absolute -left-2 h-4 w-4 rounded-full border-2 transition-all hover:bg-current"
          data-workflow-handle-kind="input"
          data-workflow-node-id={node.id}
          onPointerDown={(event) =>
            onConnectionStart(event, node.id, 'input')
          }
          style={{
            backgroundColor: isHoveredInput
              ? isInvalidInputTarget
                ? 'var(--danger-strong)'
                : theme.border
              : hasIncomingConnection
                ? 'transparent'
                : 'var(--surface-inverse)',
            borderColor: isInvalidInputTarget ? 'var(--danger-strong)' : theme.border,
            color: isInvalidInputTarget ? 'var(--danger-strong)' : theme.border,
            top: CANVAS_NODE_HANDLE_Y,
            transform: isHoveredInput
              ? 'translateY(-50%) scale(1.1)'
              : 'translateY(-50%)',
          }}
          type="button"
        />
      ) : null}

      <button
        aria-label={`Connect from ${node.label}`}
        className="absolute -right-2 h-4 w-4 rounded-full border-2 bg-[var(--surface-inverse)] transition-all hover:bg-current"
        data-workflow-handle-kind="output"
        data-workflow-node-id={node.id}
        onPointerDown={(event) =>
          onConnectionStart(event, node.id, 'output')
        }
        style={{
          backgroundColor: isHoveredOutput
            ? isInvalidOutputTarget
              ? 'var(--danger-strong)'
              : theme.border
            : hasOutgoingConnection
              ? 'transparent'
              : 'var(--surface-inverse)',
          borderColor: isInvalidOutputTarget ? 'var(--danger-strong)' : theme.border,
          color: isInvalidOutputTarget ? 'var(--danger-strong)' : theme.border,
          top: CANVAS_NODE_HANDLE_Y,
          transform: isHoveredOutput
            ? 'translateY(-50%) scale(1.1)'
            : 'translateY(-50%)',
        }}
        type="button"
      />

      <div className="flex h-full flex-col px-4 py-3">
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{
              backgroundColor: theme.badgeBackground,
              color: theme.border,
            }}
          >
            <FontAwesomeIcon
              fixedWidth
              icon={
                node.type === 'trigger'
                  ? faBolt
                  : node.type === 'tool'
                    ? faScrewdriverWrench
                    : faRobot
              }
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              {node.label}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{
                  backgroundColor: theme.badgeBackground,
                  color: theme.border,
                }}
              >
                {theme.label}
              </span>
              {node.meta ? (
                <span className="truncate text-[10px] text-[var(--muted)]">
                  {node.meta}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-auto text-[11px] leading-5 text-[var(--muted)]">
          {stepRun ? (
            <span
              className="inline-flex items-center gap-1.5 font-medium"
              style={{ color: STEP_RUN_COLORS[stepRun.status] }}
            >
              <span
                className={[
                  'inline-block h-2 w-2 rounded-full',
                  stepRun.status === 'running' ? 'animate-pulse' : '',
                ].join(' ')}
                style={{ background: STEP_RUN_COLORS[stepRun.status] }}
              />
              {stepRun.status}
              {stepRun.errorMessage ? ' — see inspector' : ''}
            </span>
          ) : (
            'Drag to position. Use the connector circles to build the workflow.'
          )}
        </div>
      </div>
    </div>
  )
}
