import { useState } from 'react'

import {
  buildWorkflowSampleTree,
  previewWorkflowJmespath,
  type WorkflowSampleTreeNode,
} from '../../../lib/workflow-designer/jmespath-preview'
import type { WorkflowStepSamplesRecord } from '../../../lib/api-client'
import { Notice } from '../../primitives/Notice'

/**
 * §5 shape awareness: the upstream sample rendered as an expandable tree —
 * clicking a node inserts its JMESPath (tree-path → expression is
 * mechanical, `treePathToJmespath`) — and the draft expression evaluated
 * live against the sample beside the editor. The evaluator is the same
 * jmespath.js the worker runs, so a green preview survives the run.
 */

const fieldLabelClass =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--tx3)]'

// The picker sits on the designer's light "canvas" surface (`--surface-inverse`,
// same as `WorkflowNodeInspector`) — these were hard-coded approximations of
// that surface's own nebula-theme values, fixed regardless of theme.
const monoChipClass =
  'rounded border border-[var(--line)] bg-[var(--surface-inverse-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink)]'

const SampleTreeRow = ({
  depth,
  node,
  onInsert,
}: {
  depth: number
  node: WorkflowSampleTreeNode
  onInsert: (expression: string) => void
}) => {
  const [expanded, setExpanded] = useState(depth === 0)
  const hasChildren = (node.children?.length ?? 0) > 0

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--surface-inverse-2)]"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <button
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="w-3 shrink-0 text-[9px] text-[var(--muted)]"
          onClick={() => setExpanded((current) => !current)}
          type="button"
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-[var(--ink)]"
          onClick={() => onInsert(node.expression)}
          title={`Insert ${node.expression}`}
          type="button"
        >
          {node.key}
          <span className="ml-1.5 text-[var(--muted)]">{node.preview}</span>
        </button>
      </div>
      {expanded && hasChildren
        ? node.children!.map((child) => (
            <SampleTreeRow
              depth={depth + 1}
              key={`${child.expression}:${child.key}`}
              node={child}
              onInsert={onInsert}
            />
          ))
        : null}
    </div>
  )
}

export const WorkflowSamplePicker = ({
  expression,
  onExpressionChange,
  onInsert,
  samples,
  upstreamStepIds,
}: {
  /** Draft transform expression — drives the live preview. */
  expression: string
  onExpressionChange?: (value: string) => void
  /** Insert an expression at the picker user's target (expression field). */
  onInsert: (expression: string) => void
  samples: WorkflowStepSamplesRecord | null | undefined
  upstreamStepIds: Array<{ id: string; label: string }>
}) => {
  const available = upstreamStepIds.filter(
    (step) => samples?.steps[step.id] !== undefined,
  )
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>(available[0]?.id)
  const effectiveStepId =
    selectedStepId && available.some((step) => step.id === selectedStepId)
      ? selectedStepId
      : available[0]?.id
  const sample = effectiveStepId ? samples?.steps[effectiveStepId] : undefined
  const preview = previewWorkflowJmespath(expression, sample)

  if (available.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-2.5 text-xs text-[var(--muted)]">
        No samples yet — run a test from the toolbar and this panel shows each
        upstream step's output as a clickable tree.
      </div>
    )
  }

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-inverse)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className={fieldLabelClass}>Sample data</span>
        <select
          className="rounded border border-[var(--line)] bg-[var(--surface-inverse)] px-1.5 py-0.5 text-[11px] text-[var(--ink)]"
          onChange={(event) => setSelectedStepId(event.target.value)}
          value={effectiveStepId}
        >
          {available.map((step) => (
            <option key={step.id} value={step.id}>
              {step.label}
            </option>
          ))}
        </select>
      </div>

      <div className="max-h-44 overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface-inverse-2)] py-1">
        <SampleTreeRow
          depth={0}
          node={buildWorkflowSampleTree(effectiveStepId ?? 'step', sample)}
          onInsert={onInsert}
        />
      </div>

      {expression.trim() ? (
        <div className="grid gap-1">
          <span className={fieldLabelClass}>Preview</span>
          {preview.kind === 'value' ? (
            <Notice size="sm" tone="success">
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">
                {JSON.stringify(preview.value, null, 2)}
              </pre>
            </Notice>
          ) : preview.kind === 'error' ? (
            <Notice size="sm" tone="danger">
              {preview.message}
            </Notice>
          ) : preview.kind === 'no-sample' ? (
            <div className="text-[11px] text-[var(--muted)]">
              Pick a step above to evaluate against its sample.
            </div>
          ) : null}
          {onExpressionChange ? null : (
            <span className={monoChipClass}>{expression}</span>
          )}
        </div>
      ) : null}
    </div>
  )
}
