// Every container a `<TabBar fullWidth />` is dropped into today, each with
// the class list copied verbatim from its call site. The strip is the real
// primitive and the stylesheet is the real one, so what `run.mjs` measures is
// `.tabbar-shell-full` against each layout mode it actually meets — grid,
// block, and the two height-bound `flex-col` asides where a block-axis grow
// once ate the conversation list.
//
// Adding a `fullWidth` call site means adding its container here.
import { createRoot } from 'react-dom/client'

import { TabBar } from '../../src/components/primitives/TabBar'
import '../../src/styles.css'

const items = [
  { label: 'All', value: 'all' },
  { label: 'Inbox', value: 'inbox' },
  { label: 'Sent', value: 'sent' },
]

const Strip = () => (
  <TabBar ariaLabel="Filter" fullWidth items={items} onChange={() => undefined} role="radiogroup" size="sm" value="all" />
)

/** Stands in for the sibling a column call site has to leave room for. */
const Filler = ({ rows }: { rows: number }) => (
  <div className="min-h-0 overflow-y-auto" data-filler>
    {Array.from({ length: rows }, (unused, index) => (
      <p className="border-b border-[var(--sep)] px-3 py-3 text-sm" key={index}>Row {index + 1}</p>
    ))}
  </div>
)

/**
 * `height` is set only for the call sites whose real container is height-bound
 * (the two mailbox asides are grid items in a fixed-height workspace); the
 * rest are measured in normal flow exactly as they render.
 */
const SITES: ReadonlyArray<{
  className: string
  /** Rows of sibling content; `1` is the reported repro — a nearly empty list. */
  filler?: number
  height?: number
  name: string
  width: number
}> = [
  // admin/src/pages/AgentMailboxPage.tsx — one conversation, the reported case.
  { className: 'flex min-h-0 flex-col gap-3 overflow-hidden', filler: 1, height: 420, name: 'agent-mailbox-aside-sparse', width: 280 },
  // …and with more conversations than fit, where the list is the one that gives.
  { className: 'flex min-h-0 flex-col gap-3 overflow-hidden', filler: 12, height: 420, name: 'agent-mailbox-aside-full', width: 280 },
  // admin/src/pages/ConnectedMailPage.tsx
  { className: 'flex min-h-0 flex-col gap-3 overflow-hidden', filler: 1, height: 420, name: 'connected-mail-aside-sparse', width: 280 },
  { className: 'flex min-h-0 flex-col gap-3 overflow-hidden', filler: 12, height: 420, name: 'connected-mail-aside-full', width: 280 },
  // admin/src/components/features/workflow-tools/ToolFilterBar.tsx
  { className: 'grid gap-2', name: 'tool-filter-bar', width: 360 },
  // admin/src/components/features/triggers/TriggerListColumn.tsx
  { className: 'grid gap-3', name: 'trigger-list-column', width: 360 },
  // admin/src/components/features/projects/kanban/TaskPriorityField.tsx
  { className: 'grid gap-1.5', name: 'task-priority-field', width: 360 },
  // admin/src/components/features/agents/AgentVisibilityPicker.tsx
  { className: 'grid gap-2', name: 'agent-visibility-picker', width: 360 },
  // admin/src/components/features/agents/designer/AgentCreationModeTabs.tsx
  { className: 'mx-auto w-full max-w-md', name: 'agent-creation-mode-tabs', width: 500 },
  // admin/src/components/features/agents/AgentDetailTabs.tsx
  { className: 'flex-shrink-0 border-b border-[color:var(--sep)] px-4 py-2', name: 'agent-detail-tabs', width: 500 },
  // admin/src/components/features/apps/AppsToolbar.tsx
  { className: 'w-full lg:w-auto lg:min-w-[14rem]', name: 'apps-toolbar', width: 300 },
  // admin/src/layouts/admin-shell/CreateTeamDialog.tsx
  { className: 'grid gap-4', name: 'create-team-dialog', width: 420 },
  // admin/src/layouts/admin-shell/user-menu/PresenceControl.tsx
  { className: 'px-2 py-1.5', name: 'presence-control', width: 260 },
]

const Fixture = () => (
  <main className="bg-[color:var(--main)] p-6 text-[color:var(--tx)]">
    {SITES.map((site) => (
      <section className="mb-6" key={site.name}>
        <p className="pb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">{site.name}</p>
        <div
          data-site-frame={site.name}
          style={{ height: site.height ? `${site.height}px` : undefined, width: `${site.width}px` }}
        >
          <div className={site.className} data-site={site.name} style={{ height: site.height ? '100%' : undefined }}>
            <Strip />
            {site.filler ? <Filler rows={site.filler} /> : null}
          </div>
        </div>
      </section>
    ))}
  </main>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Tab bar fixture root is missing.')
createRoot(root).render(<Fixture />)
