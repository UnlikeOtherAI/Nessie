// Theming exception: deliberate whiteboard canvas; revisit for full theming.
import type { WorkflowCanvasNodeType } from './types'

export const toolbarButtonClass = [
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-black/10',
  'bg-white px-2.5 text-[11px] font-medium text-[#433349] transition-colors',
  'hover:bg-[#f4eff8]',
].join(' ')

export const menuItemClass = [
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
  'text-[#433349] transition-colors hover:bg-[#f4eff8]',
].join(' ')

export const sectionLabelClass =
  'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]'

export const dividerClass = 'my-1 border-t border-black/8'

export const canvasClass = [
  'relative flex-1 overflow-hidden bg-white select-none',
  'bg-[radial-gradient(circle_at_1px_1px,rgba(116,69,199,0.12)_1px,transparent_0)]',
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
    badgeBackground: '#f1e9ff',
    border: '#7445c7',
    fill: '#fbf8ff',
    label: 'Agent',
  },
  tool: {
    badgeBackground: '#e8f6ff',
    border: '#2b8ac6',
    fill: '#f8fcff',
    label: 'Tool',
  },
  trigger: {
    badgeBackground: '#fff1df',
    border: '#d97706',
    fill: '#fffaf2',
    label: 'Trigger',
  },
}

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
  'state_get',
  'state_put',
  'web_fetch',
  'web_search',
])
