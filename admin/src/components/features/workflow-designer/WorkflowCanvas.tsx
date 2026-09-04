import type {
  Dispatch,
  CSSProperties,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react'
import { faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { canvasClass } from '../../../lib/workflow-designer/constants'
import { getConnectionGeometry } from '../../../lib/workflow-designer/geometry'
import type {
  WorkflowCanvasNode as WorkflowCanvasNodeType,
  WorkflowConnection,
  WorkflowConnectionLayout,
  WorkflowDraftConnection,
  WorkflowHoveredHandle,
} from '../../../lib/workflow-designer/types'
import type { WorkflowStepRunRecord } from '../../../lib/api-client'
import { WorkflowCanvasNode } from './WorkflowCanvasNode'

type WorkflowCanvasProps = {
  className?: string
  canvasRef: MutableRefObject<HTMLDivElement | null>
  connections: WorkflowConnection[]
  connectionLayouts: WorkflowConnectionLayout[]
  draftConnection: WorkflowDraftConnection | null
  hoveredHandle: WorkflowHoveredHandle | null
  hoveredConnectionId: string | null
  setHoveredConnectionId: Dispatch<SetStateAction<string | null>>
  invalidDraftTarget: WorkflowHoveredHandle | null
  nodes: WorkflowCanvasNodeType[]
  selectedNodeId: string | null
  stepRunsByNodeId: Map<string, WorkflowStepRunRecord>
  dragStateRef: MutableRefObject<{
    offsetX: number
    offsetY: number
    nodeId: string
    pointerId: number
  } | null>
  onClearSelection: () => void
  onNodePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    nodeId: string,
  ) => void
  onConnectionStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
    startHandleKind: 'input' | 'output',
  ) => void
  onConnectionDelete: (connectionId: string) => void
  /** Uses the exact graph renderer without any editing affordances. */
  readOnly?: boolean
  style?: CSSProperties
}

export const WorkflowCanvas = ({
  canvasRef,
  className,
  connections,
  connectionLayouts,
  draftConnection,
  hoveredHandle,
  hoveredConnectionId,
  setHoveredConnectionId,
  invalidDraftTarget,
  nodes,
  selectedNodeId,
  stepRunsByNodeId,
  dragStateRef,
  onClearSelection,
  onNodePointerDown,
  onConnectionStart,
  onConnectionDelete,
  readOnly = false,
  style,
}: WorkflowCanvasProps) => {
  return (
    <div
      ref={canvasRef}
      className={[canvasClass, className].filter(Boolean).join(' ')}
      onPointerDown={(event) => {
        if (!readOnly && event.currentTarget === event.target) {
          onClearSelection()
        }
      }}
      style={style}
    >
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
        {connectionLayouts.map((connectionLayout) => {
          return (
            <g
              key={connectionLayout.id}
              className={readOnly ? 'pointer-events-none' : 'pointer-events-auto'}
            >
              <path
                d={connectionLayout.path}
                fill="none"
                stroke={connectionLayout.color}
                strokeLinecap="round"
                strokeWidth="3"
              />
              <path
                className="cursor-pointer"
                d={connectionLayout.path}
                fill="none"
                onMouseEnter={() => setHoveredConnectionId(connectionLayout.id)}
                onMouseLeave={(event) => {
                  const relatedTarget = event.relatedTarget
                  if (
                    relatedTarget instanceof Element &&
                    relatedTarget.closest(
                      `[data-connection-delete-id="${connectionLayout.id}"]`,
                    )
                  ) {
                    return
                  }

                  setHoveredConnectionId((currentHoveredConnectionId) =>
                    currentHoveredConnectionId === connectionLayout.id
                      ? null
                      : currentHoveredConnectionId,
                  )
                }}
                stroke="transparent"
                strokeWidth="18"
              />
            </g>
          )
        })}

        {draftConnection ? (
          <path
            d={getConnectionGeometry(
              { x: draftConnection.startX, y: draftConnection.startY },
              { x: draftConnection.x, y: draftConnection.y },
            ).path}
            fill="none"
            stroke={draftConnection.color}
            strokeDasharray="8 6"
            strokeLinecap="round"
            strokeWidth="3"
          />
        ) : null}
      </svg>

      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <div className="max-w-md rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface-inverse)] px-6 py-5 text-center shadow-[0_18px_40px_var(--scrim-weak)] backdrop-blur">
            <p className="text-[13px] font-semibold text-[var(--border-strong)]">
              Select a trigger, tool, or agent to place it on the canvas.
            </p>
            <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
              Nodes drop into the middle of the workflow and can be dragged into
              position. Connect them from right to left using the circular handles.
            </p>
          </div>
        </div>
      ) : null}

      {connectionLayouts.map((connectionLayout) =>
        !readOnly && hoveredConnectionId === connectionLayout.id ? (
          <button
            key={connectionLayout.id}
            className="absolute z-40 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-[var(--surface-inverse)] shadow-[0_10px_24px_var(--scrim)] transition-transform hover:scale-105"
            data-connection-delete-id={connectionLayout.id}
            onClick={() => onConnectionDelete(connectionLayout.id)}
            onMouseEnter={() => setHoveredConnectionId(connectionLayout.id)}
            onMouseLeave={() =>
              setHoveredConnectionId((currentHoveredConnectionId) =>
                currentHoveredConnectionId === connectionLayout.id
                  ? null
                  : currentHoveredConnectionId,
              )
            }
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            style={{
              borderColor: connectionLayout.color,
              color: connectionLayout.color,
              left: connectionLayout.midpoint.x,
              top: connectionLayout.midpoint.y,
            }}
            type="button"
          >
            <FontAwesomeIcon className="text-[12px]" icon={faTrashCan} />
          </button>
        ) : null,
      )}

      {nodes.map((node) => (
        <WorkflowCanvasNode
          key={node.id}
          node={node}
          connections={connections}
          hoveredHandle={hoveredHandle}
          invalidDraftTarget={invalidDraftTarget}
          selectedNodeId={selectedNodeId}
          stepRun={stepRunsByNodeId.get(node.id)}
          isDragging={dragStateRef.current?.nodeId === node.id}
          readOnly={readOnly}
          onNodePointerDown={onNodePointerDown}
          onConnectionStart={onConnectionStart}
        />
      ))}
    </div>
  )
}
