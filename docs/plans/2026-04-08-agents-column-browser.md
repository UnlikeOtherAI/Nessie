# Agents Column Browser Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the agents section (currently buried in Settings) with a dedicated `/agents` route using a macOS Finder-style column browser for navigating agent hierarchies.

**Architecture:** A new `AgentsPage` renders inside `AdminShellLayout` with the purple sidebar hidden. The page uses a `ColumnBrowser` component (modeled after docgen's `ColumnBrowserView`) that renders N columns dynamically as the user drills into agent -> sub-agent -> sub-sub-agent chains. A `useMediaQuery` hook controls how many columns are visible (1 on mobile, 2 on tablet portrait, 3 on tablet landscape/desktop), with `translateX` CSS transitions for smooth sliding between columns.

**Tech Stack:** React, TypeScript, Tailwind CSS, TanStack React Query, existing Nessie agent API hooks (`useAgents`, `useAgentChildren`, `useAgentStatus`, `useAgentActivity`)

---

## Reference Implementation

The docgen project's `ColumnBrowserView.jsx` at `/System/Volumes/Data/.internal/projects/Projects/docgen/app/src/components/column-browser/ColumnBrowserView.jsx` is the primary reference. Key patterns to replicate:

- Stacked mode (mobile): `translateX(-${activeColumn * 100}%)` with `transition-transform duration-300 ease-out`
- Desktop mode: `translateX(-${desktopIndex * desktopShift}%)` with dynamic column widths
- Background click on column to deselect/navigate back
- `useMediaQuery` hook for breakpoint detection

## Data Model

```typescript
// From api-client.ts
type AgentRecord = {
  channelIds: string[]
  createdAt: string
  currentRunId?: string
  currentToolName?: string
  currentToolStartedAt?: string
  id: string
  lastActivityAt: string
  name: string
  parentAgentId?: string | null
  role: string
  status: AgentStatusResponse['status']
  systemPrompt?: string
  updatedAt: string
}

// From @nessie/schemas
type AgentChild = {
  agentId: string
  name: string
  status: AgentStatusResponse['status']
  purpose: string
  parentAgentId: string
  spawnedAt: string
}
```

Root agents: `agents.filter(a => !a.parentAgentId)`
Children: fetched via `useAgentChildren(agentId)` -> `GET /api/agents/:id/children`

## Breakpoints

| Breakpoint | Visible Columns | Behavior |
|---|---|---|
| `< 768px` (mobile) | 1 | Slide left/right, back button in header |
| `768px - 1023px` (tablet portrait) | 2 | Two columns side by side |
| `>= 1024px` (tablet landscape / desktop) | 3 | Three columns, horizontal overflow if deeper |

---

### Task 1: Create `useMediaQuery` hook

**Files:**
- Create: `admin/src/hooks/useMediaQuery.ts`

**Step 1: Create the hook**

```typescript
import { useEffect, useState } from 'react'

export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}
```

**Step 2: Commit**

```bash
git add admin/src/hooks/useMediaQuery.ts
git commit -m "feat(admin): add useMediaQuery hook for responsive column browser"
```

---

### Task 2: Create `AgentColumnItem` component

This is the list item rendered in each column. Shows agent name, role, status dot, and a chevron if it has children.

**Files:**
- Create: `admin/src/components/features/agents/AgentColumnItem.tsx`

**Step 1: Create the component**

```tsx
import type { AgentRecord } from '../../../lib/api-client'
import type { AgentChild } from '@nessie/schemas'
import { AgentStatusDot } from './AgentStatusDot'

type AgentColumnItemProps = {
  agent: AgentRecord | AgentChild
  hasChildren?: boolean
  isSelected: boolean
  onClick: () => void
}

const getName = (agent: AgentRecord | AgentChild): string =>
  'name' in agent ? agent.name : agent.name

const getId = (agent: AgentRecord | AgentChild): string =>
  'id' in agent ? agent.id : agent.agentId

const getRole = (agent: AgentRecord | AgentChild): string =>
  'role' in agent && typeof (agent as AgentRecord).role === 'string'
    ? (agent as AgentRecord).role
    : 'purpose' in agent
      ? (agent as AgentChild).purpose
      : ''

export const AgentColumnItem = ({
  agent,
  hasChildren,
  isSelected,
  onClick,
}: AgentColumnItemProps) => {
  const status = agent.status

  return (
    <button
      className={[
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
        isSelected
          ? 'bg-[color:var(--accent)] text-white'
          : 'text-[color:var(--tx)] hover:bg-white/8',
      ].join(' ')}
      onClick={onClick}
      type="button"
    >
      <AgentStatusDot status={status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{getName(agent)}</div>
        <div className="truncate text-xs text-[color:var(--tx3)]">{getRole(agent)}</div>
      </div>
      {hasChildren ? (
        <svg
          className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  )
}
```

**Step 2: Commit**

```bash
git add admin/src/components/features/agents/AgentColumnItem.tsx
git commit -m "feat(admin): add AgentColumnItem component for column browser"
```

---

### Task 3: Create `AgentColumn` component

A single column in the browser. Shows a header (title + optional back button on mobile) and a scrollable list of agents.

**Files:**
- Create: `admin/src/components/features/agents/AgentColumn.tsx`

**Step 1: Create the component**

```tsx
import type { ReactNode } from 'react'

type AgentColumnProps = {
  children: ReactNode
  onBack?: () => void
  showBack?: boolean
  title: string
}

export const AgentColumn = ({ children, onBack, showBack, title }: AgentColumnProps) => (
  <div className="flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
    <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
      {showBack && onBack ? (
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10"
          onClick={onBack}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <h3 className="truncate text-sm font-semibold text-white">{title}</h3>
    </div>
    <div className="flex-1 overflow-y-auto p-2">{children}</div>
  </div>
)
```

**Step 2: Commit**

```bash
git add admin/src/components/features/agents/AgentColumn.tsx
git commit -m "feat(admin): add AgentColumn wrapper component"
```

---

### Task 4: Create `AgentDetailColumn` component

The detail view shown in the rightmost column when an agent is selected and has no deeper selection. Reuses data from existing hooks.

**Files:**
- Create: `admin/src/components/features/agents/AgentDetailColumn.tsx`

**Step 1: Create the component**

```tsx
import { useMemo } from 'react'
import {
  useAgentActivity,
  useAgentMessages,
  useAgentStatus,
} from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentStatusDot } from './AgentStatusDot'
import { AgentThoughtStream } from './AgentThoughtStream'
import { AgentMessagePreview } from './AgentMessagePreview'
import { ToolExecutionLog } from './ToolExecutionLog'

type AgentDetailColumnProps = {
  agent: AgentRecord
  onBack?: () => void
  showBack?: boolean
}

const getStatusTone = (status: AgentRecord['status']) => {
  if (status === 'error') return 'danger'
  if (status === 'waiting_approval') return 'warning'
  if (status === 'idle' || status === 'offline') return 'muted'
  return 'accent'
}

export const AgentDetailColumn = ({ agent, onBack, showBack }: AgentDetailColumnProps) => {
  const { data: status } = useAgentStatus(agent.id)
  const { data: activity } = useAgentActivity(agent.id)
  const { data: messages = [] } = useAgentMessages(agent.id, 5)

  const toolEntries = useMemo(() => {
    if (!activity) return []
    return activity.recentToolCalls.length > 0
      ? activity.recentToolCalls
      : activity.currentRun?.toolCalls ?? []
  }, [activity])

  return (
    <div className="flex h-full flex-col bg-[color:var(--main)]">
      <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-6 py-5">
        <div className="flex items-center gap-2">
          {showBack && onBack ? (
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-white/10"
              onClick={onBack}
              type="button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <h2 className="text-xl font-semibold text-white">{agent.name}</h2>
          <AgentStatusDot status={agent.status} />
          <StatusPill tone={getStatusTone(agent.status)}>{agent.status}</StatusPill>
        </div>
        <div className="mt-2 text-sm text-[color:var(--tx2)]">{agent.role}</div>
        <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {status?.currentToolName
            ? `Active tool: ${status.currentToolName}`
            : `Last activity ${new Date(agent.lastActivityAt).toLocaleString()}`}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="grid gap-6">
          <section className="admin-card p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
              Current activity
            </div>
            {status?.currentToolName || activity?.currentRun ? (
              <div className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
                {status?.currentToolName
                  ? `${agent.name} is running ${status.currentToolName}.`
                  : `Run ${activity?.currentRun?.runId ?? agent.currentRunId ?? 'pending'} is active.`}
              </div>
            ) : (
              <EmptyState>This agent is currently idle.</EmptyState>
            )}
          </section>

          <ToolExecutionLog entries={toolEntries} />
          <AgentThoughtStream />
          <AgentMessagePreview messages={messages} />
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add admin/src/components/features/agents/AgentDetailColumn.tsx
git commit -m "feat(admin): add AgentDetailColumn for column browser detail view"
```

---

### Task 5: Create `AgentColumnBrowser` component

The main column browser. Manages selection path state, builds columns dynamically, and handles responsive layout with `translateX` sliding.

**Files:**
- Create: `admin/src/components/features/agents/AgentColumnBrowser.tsx`

**Step 1: Create the component**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentChildren, useAgents } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import { AgentColumn } from './AgentColumn'
import { AgentColumnItem } from './AgentColumnItem'
import { AgentDetailColumn } from './AgentDetailColumn'

type ColumnEntry = {
  agentId: string | null // null = root column
  title: string
}

// Fetches children for a column and renders the list
const AgentChildrenList = ({
  parentId,
  selectedId,
  onSelect,
}: {
  parentId: string
  selectedId: string | null
  onSelect: (agentId: string) => void
}) => {
  const { data: children = [] } = useAgentChildren(parentId)

  if (children.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
        No sub-agents spawned yet.
      </div>
    )
  }

  return (
    <div className="grid gap-1">
      {children.map((child) => (
        <AgentColumnItem
          key={child.agentId}
          agent={child}
          isSelected={selectedId === child.agentId}
          onClick={() => onSelect(child.agentId)}
        />
      ))}
    </div>
  )
}

export const AgentColumnBrowser = () => {
  const { data: allAgents = [] } = useAgents()
  const isMobile = !useMediaQuery('(min-width: 768px)')
  const isTabletPortrait = useMediaQuery('(min-width: 768px)') && !useMediaQuery('(min-width: 1024px)')
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  const visibleColumns = isMobile ? 1 : isTabletPortrait ? 2 : 3

  // Selection path: ordered list of selected agent IDs at each depth
  const [selectionPath, setSelectionPath] = useState<string[]>([])
  const [activeColumn, setActiveColumn] = useState(0)

  const rootAgents = useMemo(
    () => allAgents.filter((agent) => !agent.parentAgentId),
    [allAgents],
  )

  // Find full AgentRecord for any ID in the path
  const findAgent = useCallback(
    (id: string): AgentRecord | undefined => allAgents.find((a) => a.id === id),
    [allAgents],
  )

  // Select an agent at a given depth
  const selectAtDepth = useCallback((agentId: string, depth: number) => {
    setSelectionPath((prev) => {
      const next = prev.slice(0, depth)
      next.push(agentId)
      return next
    })
    setActiveColumn(depth + 1)
  }, [])

  // Navigate back to a specific depth
  const navigateBack = useCallback((toDepth: number) => {
    setSelectionPath((prev) => prev.slice(0, toDepth))
    setActiveColumn(toDepth)
  }, [])

  // Sync activeColumn when selectionPath shrinks
  useEffect(() => {
    if (activeColumn > selectionPath.length) {
      setActiveColumn(selectionPath.length)
    }
  }, [selectionPath.length, activeColumn])

  // Build columns array
  // Column 0: root agents
  // Column 1..N-1: children of selectionPath[N-2] + detail header
  // Column N (final): detail of deepest selected agent (if no further selection)
  const columns = useMemo(() => {
    const result: { key: string; content: React.ReactNode }[] = []

    // Root column
    result.push({
      key: 'root',
      content: (
        <AgentColumn
          title="Agents"
          showBack={isMobile && selectionPath.length > 0}
          onBack={() => navigateBack(0)}
        >
          {rootAgents.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
              No agents created yet.
            </div>
          ) : (
            <div className="grid gap-1">
              {rootAgents.map((agent) => (
                <AgentColumnItem
                  key={agent.id}
                  agent={agent}
                  hasChildren
                  isSelected={selectionPath[0] === agent.id}
                  onClick={() => selectAtDepth(agent.id, 0)}
                />
              ))}
            </div>
          )}
        </AgentColumn>
      ),
    })

    // Intermediate columns: for each selected agent, show its children
    for (let depth = 0; depth < selectionPath.length; depth++) {
      const agentId = selectionPath[depth]
      const agent = findAgent(agentId)
      const selectedChildId = selectionPath[depth + 1] ?? null
      const depthCapture = depth

      result.push({
        key: `children-${agentId}`,
        content: (
          <AgentColumn
            title={agent?.name ?? 'Agent'}
            showBack={isMobile}
            onBack={() => navigateBack(depthCapture)}
          >
            {/* Agent summary at top of column */}
            {agent ? (
              <div className="mb-3 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
                <div className="text-sm font-medium text-white">{agent.name}</div>
                <div className="mt-1 text-xs text-[color:var(--tx3)]">{agent.role}</div>
              </div>
            ) : null}
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] px-1">
              Sub-agents
            </div>
            <AgentChildrenList
              parentId={agentId}
              selectedId={selectedChildId}
              onSelect={(childId) => selectAtDepth(childId, depthCapture + 1)}
            />
          </AgentColumn>
        ),
      })
    }

    // Detail column for the deepest selected agent
    if (selectionPath.length > 0) {
      const deepestId = selectionPath[selectionPath.length - 1]
      const deepestAgent = findAgent(deepestId)
      if (deepestAgent) {
        result.push({
          key: `detail-${deepestId}`,
          content: (
            <AgentDetailColumn
              agent={deepestAgent}
              showBack={isMobile}
              onBack={() => navigateBack(selectionPath.length - 1)}
            />
          ),
        })
      }
    }

    return result
  }, [rootAgents, selectionPath, findAgent, selectAtDepth, navigateBack, isMobile])

  // Calculate transform for sliding
  const totalColumns = columns.length

  // For mobile: show one column at a time, slide to activeColumn
  // For tablet/desktop: show N columns, shift when activeColumn moves beyond visible range
  const desktopStartIndex = Math.max(0, Math.min(activeColumn - (visibleColumns - 1), totalColumns - visibleColumns))
  const columnWidthPercent = 100 / visibleColumns

  if (isMobile) {
    return (
      <div className="flex h-full flex-col">
        <div className="relative flex-1 overflow-hidden">
          <div
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${activeColumn * 100}%)` }}
          >
            {columns.map((column, index) => (
              <div
                key={column.key}
                className={[
                  'h-full w-full shrink-0',
                  index !== activeColumn ? 'invisible' : '',
                ].join(' ')}
              >
                {column.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-out"
          style={{
            transform: `translateX(-${desktopStartIndex * columnWidthPercent}%)`,
          }}
        >
          {columns.map((column, index) => {
            const isOffScreen =
              index < desktopStartIndex || index >= desktopStartIndex + visibleColumns
            return (
              <div
                key={column.key}
                className={[
                  'h-full shrink-0 transition-[width] duration-300 ease-out',
                  isOffScreen ? 'invisible' : '',
                ].join(' ')}
                style={{ width: `${columnWidthPercent}%` }}
              >
                {column.content}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add admin/src/components/features/agents/AgentColumnBrowser.tsx
git commit -m "feat(admin): add AgentColumnBrowser with responsive Finder-style navigation"
```

---

### Task 6: Create `AgentsPage`

Simple page wrapper that renders the column browser.

**Files:**
- Create: `admin/src/pages/AgentsPage.tsx`

**Step 1: Create the page**

```tsx
import { AgentColumnBrowser } from '../components/features/agents/AgentColumnBrowser'

export const AgentsPage = () => (
  <div className="h-full">
    <AgentColumnBrowser />
  </div>
)
```

**Step 2: Commit**

```bash
git add admin/src/pages/AgentsPage.tsx
git commit -m "feat(admin): add AgentsPage"
```

---

### Task 7: Add `/agents` route and hide sidebar

**Files:**
- Modify: `admin/src/router.tsx` - add `/agents` route
- Modify: `admin/src/layouts/AdminShellLayout.tsx` - hide purple sidebar on `/agents`, update rail Agents button to link to `/agents`

**Step 1: Update router**

In `admin/src/router.tsx`, add the import and route:

```typescript
import { AgentsPage } from './pages/AgentsPage'
```

Add inside the `AdminShellLayout` children array:

```typescript
{
  path: '/agents',
  element: <AgentsPage />,
},
```

**Step 2: Update AdminShellLayout**

In `admin/src/layouts/AdminShellLayout.tsx`:

1. Detect if current route is `/agents` using `location.pathname`:

```typescript
const isAgentsRoute = location.pathname.startsWith('/agents')
```

2. Conditionally hide the purple sidebar (the second `<aside>`) when `isAgentsRoute` is true. Change the sidebar's className to include a condition:

```tsx
// Change: 'hidden h-full w-[260px] flex-col overflow-hidden ...'
// To conditionally not render it when on /agents route
{!isAgentsRoute && (
  <aside className={[
    'hidden h-full w-[260px] flex-col overflow-hidden',
    'border-r border-[color:var(--sep)] bg-[color:var(--sb)] md:flex',
  ].join(' ')}>
    {/* ... existing sidebar content ... */}
  </aside>
)}
```

3. Update the Agents rail button to link to `/agents` instead of navigating to `/settings#agents`:

```tsx
// Change from:
<button className="admin-rail-btn" onClick={() => void navigate('/settings#agents')} type="button">
// To:
<Link className={`admin-rail-btn ${isAgentsRoute ? 'active' : ''}`} to="/agents">
```

Remember to ensure the SVG content inside the button is preserved — only the wrapper element changes from `<button>` to `<Link>`.

**Step 3: Build and verify**

Run: `pnpm --filter @nessie/admin build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add admin/src/router.tsx admin/src/layouts/AdminShellLayout.tsx
git commit -m "feat(admin): add /agents route with sidebar hidden, link rail button"
```

---

### Task 8: Add column browser styles

**Files:**
- Modify: `admin/src/styles.css`

**Step 1: Add the slide animation keyframe and column styles**

Append to `admin/src/styles.css`:

```css
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
    opacity: 0.8;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in-right {
  animation: slide-in-right 300ms ease-out;
}
```

**Step 2: Commit**

```bash
git add admin/src/styles.css
git commit -m "feat(admin): add slide-in-right animation for column browser"
```

---

### Task 9: Build, verify, and final commit

**Step 1: Build the admin**

Run: `pnpm --filter @nessie/admin build`
Expected: Build succeeds with no TypeScript or lint errors.

**Step 2: Manual verification checklist**

- [ ] `/agents` route loads and shows root agents in first column
- [ ] Clicking a root agent shows its sub-agents in column 2
- [ ] Clicking a sub-agent shows its children in column 3 (or detail if no children)
- [ ] Detail column shows agent status, tools, messages
- [ ] Mobile (< 768px): single column with slide animation and back button
- [ ] Tablet portrait (768-1023px): two columns visible
- [ ] Desktop (>= 1024px): three columns visible
- [ ] Rail "Agents" button links to `/agents` and shows active state
- [ ] Purple sidebar is hidden on `/agents` route
- [ ] Purple sidebar still shows on `/channels` and `/settings` routes

**Step 3: Push**

```bash
git push
```
