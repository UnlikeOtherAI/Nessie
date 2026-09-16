import { Fragment } from 'react'
import {
  faBook,
  faClockRotateLeft,
  faHouse,
  faLayerGroup,
  faShareNodes,
} from '@fortawesome/free-solid-svg-icons'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { useProductSurfaces } from '../../../../facades/integrations/useProductSurfaces'
import { prewarmRowHandlers, usePrewarm } from '../../../../navigation/prewarm'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { ProjectAvatar } from '../../../primitives/ProjectAvatar'
import { Pill } from '../../../primitives/Pill'
import { QueryState } from '../../../shared/QueryState'
import { RowList, type RowDragHandlers } from '../../../shared/RowList'
import { Skeleton } from '../../../primitives/Skeleton'
import { FinderRow } from './FinderRow'
import type {
  FinderBackgroundMenuProps,
  FinderRowMenuProps,
} from './FinderContextMenus'

/**
 * The root column (browser-ui.md §3): the first column of the browser, and
 * what replaced the navy `KnowledgeSidebarNav`.
 *
 * Latest, Shared with me, a hairline, My Documents and one row per project, a
 * hairline, the shared folders, a hairline, Dashboards and any product views.
 * A group with nothing in it omits itself *and* its separator — an empty
 * group with a rule over it is a heading for nothing.
 */

export type FinderRootRow =
  | { kind: 'latest'; id: 'virtual:latest' }
  | { kind: 'shared-with-me'; id: 'virtual:shared'; count: number }
  | { kind: 'space'; id: string; space: KnowledgeRootSpace; role: 'personal' | 'project' | 'shared' }
  | { kind: 'project-unopened'; id: string; projectId: string; projectName: string }
  | {
      kind: 'product-view'
      id: string
      view: string
      label: string
      product: string
      /** The manifest's glyph is a character (an emoji), not an icon name. */
      glyph?: string
    }

/** The order the overview's root model fixes, as data the column just draws. */
export const finderRootGroups = (root: KnowledgeRoot | undefined): FinderRootRow[][] => {
  if (!root) return []
  const virtual: FinderRootRow[] = [
    { id: 'virtual:latest', kind: 'latest' },
    { count: root.sharedWithMeCount, id: 'virtual:shared', kind: 'shared-with-me' },
  ]
  const mine: FinderRootRow[] = [
    { id: root.myDocuments.spaceId, kind: 'space', role: 'personal', space: root.myDocuments },
    ...root.projects.map((project): FinderRootRow =>
      project.space
        ? { id: project.space.spaceId, kind: 'space', role: 'project', space: project.space }
        : {
            id: `project:${project.projectId}`,
            kind: 'project-unopened',
            projectId: project.projectId,
            projectName: project.projectName,
          },
    ),
  ]
  const shared: FinderRootRow[] = root.shared.map((space) => ({
    id: space.spaceId,
    kind: 'space',
    role: 'shared',
    space,
  }))
  return [virtual, mine, shared]
}

type FinderRootColumnProps = {
  activeRowId?: string
  columnActive: boolean
  focusedRowId?: string
  /** "New shared folder…" and Refresh, off the column's empty background. */
  backgroundProps?: FinderBackgroundMenuProps
  /**
   * A root folder is the far side of a cross-space move or copy, and the root
   * column is one of only two places one appears (the other is a project tab's
   * sibling-space rows). Without these a drag onto "My Documents" lands on
   * nothing and the move-or-copy prompt is unreachable — Rule zero's defect
   * for the whole transfer feature.
   *
   * `dropHandlersForSpace(spaceId)` is `useFinderDrag`'s
   * `dropHandlersFor(spaceId, { kind: 'folder', parentPageId: null, spaceId })`;
   * `dropTargetId` is its `dropTargetKey`.
   */
  dropHandlersForSpace?: (spaceId: string) => RowDragHandlers
  dropTargetId?: string | null
  onOpen: (row: FinderRootRow) => void
  /** `useFinderMenus().rowProps`, spread on each row. */
  rowProps?: (row: FinderRootRow) => FinderRowMenuProps
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  root?: KnowledgeRoot
}

// A list item, because it sits between `<li>` rows: a `<div>` there is
// invalid inside a `<ul>` and browsers reparent it, which moves the rule.
const Separator = () => <li aria-hidden="true" className="finder-separator" role="separator" />

export const FinderRootColumn = ({
  activeRowId,
  backgroundProps,
  columnActive,
  dropHandlersForSpace,
  dropTargetId,
  focusedRowId,
  onOpen,
  query,
  root,
  rowProps,
}: FinderRootColumnProps) => {
  const { token } = useAuthSession()
  const { documentsSections } = useProductSurfaces()
  const prewarm = usePrewarm()

  const groups = finderRootGroups(root)
  // Dashboards is deliberately absent. It carried an interim row here while
  // its only doorway was the navy sidebar this redesign deleted; it is now a
  // project section (`/projects/:projectId/dashboards`) and the global
  // `/dashboards` route no longer exists, so a row here would be a doorway to
  // a 404 — the opposite of the rule it was added for.
  const links: FinderRootRow[] = [
    ...documentsSections.map((section): FinderRootRow => ({
      glyph: section.iconGlyph,
      id: `view:${section.view}`,
      kind: 'product-view',
      label: section.label,
      product: section.productName,
      view: section.view,
    })),
  ]
  const rendered = [...groups, links].filter((group) => group.length > 0)
  const firstId = rendered[0]?.[0]?.id

  // Where a row goes, so the fetch starts on the press rather than on the
  // landing: an unwarmed row is a screen that arrives empty after the slide.
  const destination = (row: FinderRootRow): string | null => {
    switch (row.kind) {
      case 'latest': return '/knowledge-base/latest'
      case 'shared-with-me': return '/knowledge-base/shared-with-me'
      case 'space': return `/knowledge-base/spaces/${encodeURIComponent(row.space.spaceId)}`
      case 'product-view': return `/knowledge-base/views/${encodeURIComponent(row.view)}`
      default: return null
    }
  }

  const renderRow = (row: FinderRootRow) => {
    const selected = activeRowId === row.id
    const to = destination(row)
    // Only a real root folder can receive a transfer. Latest and Shared with
    // me are listings the server computes and Dashboards is a link: a drop on
    // any of them has no destination to write to.
    const droppableSpaceId = row.kind === 'space' ? row.space.spaceId : null
    const shared = {
      chevron: true,
      columnActive,
      ...(droppableSpaceId && dropHandlersForSpace
        ? {
          dragHandlers: dropHandlersForSpace(droppableSpaceId),
          dropTarget: dropTargetId === droppableSpaceId,
        }
        : {}),
      id: row.id,
      ...(rowProps ? rowProps(row) : {}),
      onOpen: () => onOpen(row),
      prewarm: to ? prewarmRowHandlers(prewarm, to) : undefined,
      selected,
      // Roving tabindex: one row per column is tabbable, so Tab leaves the
      // column instead of walking every file in it.
      tabIndex: (focusedRowId ?? activeRowId ?? firstId) === row.id ? 0 : -1,
      variant: 'root' as const,
    }

    switch (row.kind) {
      case 'latest':
        return (
          <FinderRow
            {...shared}
            ariaLabel="Latest documents"
            icon={faClockRotateLeft}
            iconTone="--accent"
            key={row.id}
            kind="virtual"
            title="Latest"
          />
        )
      case 'shared-with-me':
        return (
          <FinderRow
            {...shared}
            icon={faShareNodes}
            iconTone="--accent"
            key={row.id}
            kind="virtual"
            title="Shared with me"
            trailing={row.count > 0
              ? <Pill size="sm" tone="accent">{row.count}</Pill>
              : undefined}
          />
        )
      case 'space': {
        const { space } = row
        if (row.role === 'personal') {
          return (
            <FinderRow
              {...shared}
              icon={faHouse}
              iconTone="--accent"
              key={row.id}
              kind="space"
              title="My Documents"
            />
          )
        }
        if (row.role === 'project') {
          return (
            <FinderRow
              {...shared}
              key={row.id}
              kind="space"
              // One identity tile, never a folder glyph standing in for a
              // project that already has a picture.
              leading={<ProjectAvatar size={20} token={token} />}
              title={space.projectName ?? space.name}
            />
          )
        }
        return (
          <FinderRow
            {...shared}
            icon={space.ownerAgentId ? undefined : faLayerGroup}
            iconTone="--accent"
            key={row.id}
            kind="space"
            leading={space.ownerAgentId
              ? <AgentAvatar agentId={space.ownerAgentId} size={20} token={token} />
              : undefined}
            locked={space.writeRestricted}
            subtitle={space.ownerAgentId ? 'Agent documents' : space.projectName ?? undefined}
            title={space.name}
          />
        )
      }
      case 'project-unopened':
        return (
          <FinderRow
            {...shared}
            key={row.id}
            kind="space"
            leading={<ProjectAvatar size={20} token={token} />}
            title={row.projectName}
          />
        )
      case 'product-view':
        return (
          <FinderRow
            {...shared}
            icon={row.glyph ? undefined : faBook}
            iconTone="--tx2"
            key={row.id}
            kind="link"
            leading={row.glyph
              ? (
                <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center text-sm">
                  {row.glyph}
                </span>
              )
              : undefined}
            subtitle={row.product}
            title={row.label}
          />
        )
    }
  }

  return (
    <div className="h-full" {...backgroundProps}>
      <QueryState
        className="py-6"
        errorLabel="Couldn’t load your documents."
        loadingLabel="Loading documents…"
        query={query}
      >
        {() =>
          root === undefined ? (
            <Skeleton count={5} variant="list" />
          ) : (
            <RowList label="Documents" role="listbox" variant="finder">
              {rendered.map((group, index) => (
                <Fragment key={index}>
                  {index > 0 ? <Separator /> : null}
                  {group.map(renderRow)}
                </Fragment>
              ))}
            </RowList>
          )
        }
      </QueryState>
    </div>
  )
}
