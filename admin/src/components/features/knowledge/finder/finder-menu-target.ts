import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { FinderMenuRootRow, FinderMenuTarget } from './finder-menu'
import type { GetInfoTarget } from './GetInfoDialog'
import type { FinderRootRow } from './FinderRootColumn'
import type { FinderVirtualRow } from './FinderVirtualColumn'

/**
 * What a menu is being opened *on*, and how the three kinds of row become the
 * one shape `buildFinderMenu` reads.
 *
 * All pure, and apart from the hook on purpose: a root row, a virtual row and
 * a page in the open folder are three different records with three different
 * facts, and flattening them is a decision worth reading on its own rather
 * than one buried in a `useMemo` beside the focus handling.
 */

/**
 * A bare `KnowledgePageRecord` is accepted as well as the tagged forms,
 * because a folder column has nothing else to hand over and that is the
 * overwhelming case; the tags exist for the two kinds of row that are not
 * pages in the open folder — a root folder, and a virtual row standing in for
 * a page that lives somewhere else.
 */
export type FinderMenuRowRef =
  | KnowledgePageRecord
  | { kind: 'page'; page: KnowledgePageRecord }
  | { kind: 'virtual'; row: FinderVirtualRow }
  | { kind: 'root'; row: FinderRootRow }

export type FinderMenuColumnRef =
  | { kind: 'root' }
  | { kind: 'virtual' }
  | { kind: 'folder'; parentPageId: string | null }
  /** A folder column, named the way `FinderFolderHost` already knows it. */
  | { parentPageId: string | null; spaceId: string }

export type FinderMenuTaggedColumn =
  Exclude<FinderMenuColumnRef, { parentPageId: string | null; spaceId: string }>

/** What the hook is holding while a menu is open. */
export type FinderMenuActiveTarget =
  | { kind: 'pages'; pages: KnowledgePageRecord[] }
  | { kind: 'virtual'; row: FinderVirtualRow }
  | { kind: 'root'; row: FinderRootRow }
  | { kind: 'background'; column: FinderMenuTaggedColumn }

export const asRowRef = (
  row: FinderMenuRowRef,
): Exclude<FinderMenuRowRef, KnowledgePageRecord> => (
  row.kind === 'page' || row.kind === 'virtual' || row.kind === 'root'
    ? row
    : { kind: 'page', page: row }
)

export const asColumnRef = (column: FinderMenuColumnRef): FinderMenuTaggedColumn => (
  'kind' in column ? column : { kind: 'folder', parentPageId: column.parentPageId }
)

/** A root row, reduced to what decides its menu. */
export const rootRowDescriptor = (row: FinderRootRow): FinderMenuRootRow => {
  switch (row.kind) {
    case 'space':
      if (row.role === 'personal') return { role: 'personal' }
      if (row.role === 'project') return { projectId: row.space.projectId, role: 'project' }
      if (row.space.ownerAgentId) {
        return {
          agentId: row.space.ownerAgentId,
          canManageAccess: row.space.canManageAccess,
          role: 'agent',
        }
      }
      return {
        canManageAccess: row.space.canManageAccess,
        canWrite: row.space.canWrite,
        role: 'shared',
      }
    case 'project-unopened':
      return { projectId: row.projectId, role: 'project' }
    default:
      return { role: 'link' }
  }
}

const pageDescriptor = (page: KnowledgePageRecord) => ({
  id: page.id,
  indexing: page.indexing,
  kind: page.kind as 'folder' | 'document' | 'file',
  status: page.status,
  // A task folder names its ticket, and the ticket id is the only thing a
  // listing carries about it.
  taskId: (page.metadata?.taskId as string | undefined) ?? null,
  title: page.title,
})

/** The active target as the menu builder's own shape; `null` while closed. */
export const finderMenuTargetFor = (
  active: FinderMenuActiveTarget | null,
): FinderMenuTarget | null => {
  if (!active) return null
  switch (active.kind) {
    case 'pages': {
      // Two or more rows get the short menu of what is true of all of them.
      if (active.pages.length > 1) {
        return { kind: 'selection', pages: active.pages.map(pageDescriptor) }
      }
      const page = active.pages[0]
      return page ? { kind: 'page', page: pageDescriptor(page), virtual: false } : null
    }
    case 'virtual':
      return {
        kind: 'page',
        page: {
          // `access` is what the server will actually allow on somebody else's
          // page, and it outranks the column's own write verdict.
          access: active.row.access,
          id: active.row.id,
          indexing: active.row.indexing,
          kind: active.row.kind as 'folder' | 'document' | 'file',
          status: 'published',
          title: active.row.title,
        },
        virtual: true,
      }
    case 'root':
      return { kind: 'root-row', row: rootRowDescriptor(active.row) }
    case 'background':
      return { column: active.column.kind, kind: 'background' }
  }
}

/**
 * What Get Info is asked about: the row, or — on a root row or an empty
 * background — the root folder the column is showing.
 */
export const infoTargetFor = ({
  first,
  rootRow,
  space,
  virtualRow,
}: {
  first?: KnowledgePageRecord
  rootRow?: FinderRootRow
  space?: { id: string; name: string } | null
  virtualRow?: { id: string; title: string }
}): GetInfoTarget | null => {
  if (first) return { kind: 'page', pageId: first.id, title: first.title }
  if (virtualRow) return { kind: 'page', pageId: virtualRow.id, title: virtualRow.title }
  if (rootRow?.kind === 'space') {
    return { kind: 'space', spaceId: rootRow.space.spaceId, title: rootRow.space.name }
  }
  return space ? { kind: 'space', spaceId: space.id, title: space.name } : null
}
