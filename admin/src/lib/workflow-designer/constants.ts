import type { WorkflowCanvasNodeType } from './types'

export const toolbarButtonClass = [
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)]',
  'bg-[var(--surface-inverse)] px-2.5 text-[11px] font-medium text-[var(--ink)] transition-colors',
  'hover:bg-[var(--surface-inverse-2)]',
].join(' ')

export const sectionLabelClass =
  'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]'

export const canvasClass = [
  'relative flex-1 overflow-hidden bg-[var(--surface-inverse)] select-none',
  'bg-[radial-gradient(circle_at_1px_1px,color-mix(in_srgb,var(--accent)_12%,transparent)_1px,transparent_0)]',
  '[background-size:28px_28px]',
].join(' ')

export const CANVAS_PADDING = 24
export const CANVAS_NODE_WIDTH = 244
export const CANVAS_NODE_HEIGHT = 96
export const CANVAS_NODE_HANDLE_Y = CANVAS_NODE_HEIGHT / 2
export const CANVAS_NODE_INSERT_OFFSET = 28
export const CANVAS_NODE_INSERT_STEPS = 6
export const DEFAULT_WORKFLOW_NAME = 'Untitled workflow'
export const WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY = 'nessie.admin.workflow-designer.draft'

// Each node type maps to one semantic token (accent/info/success/warning) and
// is tinted onto the canvas's `--surface-inverse` via color-mix so the badge
// and fill stay legible on the light "whiteboard" surface in every theme,
// including dark ones where `--surface-inverse` stays light by design.
export const nodeThemes: Record<
  WorkflowCanvasNodeType,
  {
    badgeBackground: string
    border: string
    fill: string
    label: string
  }
> = {
  agent: {
    badgeBackground: 'color-mix(in srgb, var(--accent) 16%, var(--surface-inverse))',
    border: 'var(--accent)',
    fill: 'color-mix(in srgb, var(--accent) 4%, var(--surface-inverse))',
    label: 'Agent',
  },
  tool: {
    badgeBackground: 'color-mix(in srgb, var(--info) 16%, var(--surface-inverse))',
    border: 'var(--info)',
    fill: 'color-mix(in srgb, var(--info) 4%, var(--surface-inverse))',
    label: 'Tool',
  },
  transform: {
    badgeBackground: 'color-mix(in srgb, var(--success) 16%, var(--surface-inverse))',
    border: 'var(--success)',
    fill: 'color-mix(in srgb, var(--success) 4%, var(--surface-inverse))',
    label: 'Transform',
  },
  trigger: {
    badgeBackground: 'color-mix(in srgb, var(--warning) 16%, var(--surface-inverse))',
    border: 'var(--warning)',
    fill: 'color-mix(in srgb, var(--warning) 4%, var(--surface-inverse))',
    label: 'Trigger',
  },
}

// W17: executable STEP TYPES with a registered worker executor — mirrors
// `WORKFLOW_STEP_TYPES` in api/src/services/workflow-validation.ts, which carries the
// same executor-registration rule. Drift fails the same way W12's tool list
// drift does: an authoring surface advertising a capability that can only
// fail at run time.
export const WORKFLOW_EXECUTABLE_STEP_TYPES = new Set([
  'agent',
  'agent_task',
  'environment_launch',
  'message_send',
  'tool',
  'tool_call',
  'transform',
])

export const WORKFLOW_TRIGGER_TYPE_LABELS = {
  event: 'Event trigger',
  interval: 'Interval trigger',
  manual: 'Manual trigger',
  scheduled: 'Scheduled trigger',
  webhook: 'Webhook trigger',
} as const

// W12: the one executable tool list is `WORKFLOW_TOOL_IDS` in
// @nessie/runtime; this mirrors it for the canvas, which cannot import that
// package. `admin/test/workflow-tool-allowlist.test.ts` fails the moment the
// two drift apart, so they are not "agreeing by coincidence".
export const WORKFLOW_TOOL_NODE_IDS = new Set([
  'change_detect',
  'message_send',
  'state_get',
  'state_put',
  'web_fetch',
  'web_search',
])
