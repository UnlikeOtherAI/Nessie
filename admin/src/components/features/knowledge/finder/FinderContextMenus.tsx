import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { KnowledgeAccessSummary, KnowledgeIndexingState } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { useReindexPage, useRenamePage } from '../../../../facades/knowledge/finder-hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { useToasts } from '../../../../providers/ToastProvider'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { ContextMenu } from '../../../overlays/ContextMenu'
import { useContextMenu } from '../../../overlays/useContextMenu'
import { knowledgeKeys } from '../../../../facades/knowledge/keys'
import { useKnowledge } from '../KnowledgeProvider'
import { AccessReadoutDialog } from './AccessReadoutDialog'
import { GetInfoDialog, type GetInfoTarget } from './GetInfoDialog'
import { ShareDialog } from './ShareDialog'
import { useRemovePageShare } from './share-hooks'
import { sharingSurfaceFor, buildFinderMenu, finderMenuLabel } from './finder-menu'
import type { FinderMenuHandlers, FinderMenuRootRow, FinderMenuTarget } from './finder-menu'
import type { FinderRootRow } from './FinderRootColumn'
import type { FinderVirtualRow } from './FinderVirtualColumn'
import type { FinderRowRename } from './RenameRow'
import { deleteConfirmCopy, pageLink, spaceAccessSummary } from './finder-menu-context'

/**
 * Right-click, everywhere in the Finder (menus-and-dialogs.md §2–§4, §8).
 *
 * One hook, mounted once by the browser, that owns the menu's anchoring and
 * focus and every dialog a menu opens. Columns stay ignorant of all of it:
 * they call `rowProps(row)` and spread the result on their `FinderRow`, and
 * `backgroundProps(column)` on the column body.
 *
 * ```tsx
 * const menus = useFinderMenus({ selectedIds, onNewFolderIn, onUploadFiles })
 * <FinderRow {...menus.rowProps({ kind: 'page', page })} … />
 * <div {...menus.backgroundProps({ kind: 'folder', parentPageId })}>…</div>
 * {menus.dialogs}
 * ```
 *
 * What it does *not* do is decide what the menu contains: that is
 * `buildFinderMenu`, a pure function with its own suite. This file is the
 * wiring — which page the gesture landed on, where focus goes when the row it
 * opened on has just been deleted, and which dialog a label opens.
 */

/**
 * What a menu is being opened on. A bare `KnowledgePageRecord` is accepted as
 * well as the tagged forms, because a folder column has nothing else to hand
 * over and that is the overwhelming case; the tags exist for the two kinds of
 * row that are not pages in the open folder — a root folder, and a virtual
 * row standing in for a page that lives somewhere else.
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

const asRowRef = (
  row: FinderMenuRowRef,
): Exclude<FinderMenuRowRef, KnowledgePageRecord> => (
  row.kind === 'page' || row.kind === 'virtual' || row.kind === 'root'
    ? row
    : { kind: 'page', page: row }
)

const asColumnRef = (
  column: FinderMenuColumnRef,
): Exclude<FinderMenuColumnRef, { parentPageId: string | null; spaceId: string }> => (
  'kind' in column ? column : { kind: 'folder', parentPageId: column.parentPageId }
)

/** Spread straight onto a `FinderRow`. Both props are ones no column computes. */
export type FinderRowMenuProps = {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
  rename?: FinderRowRename
}

export type FinderBackgroundMenuProps = {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}

/** The whole hook, as a type a column can take as one prop. */
export type FinderMenus = {
  rowProps: (row: FinderMenuRowRef) => FinderRowMenuProps
  backgroundProps: (column: FinderMenuColumnRef) => FinderBackgroundMenuProps
  dialogs: ReactNode
}

/**
 * Everything the host contributes. All of it is optional, and an item whose
 * doorway is missing is **absent from the menu** rather than inert — so a host
 * that mounts the hook bare still gets a correct menu, just a shorter one.
 */
export type UseFinderMenusOptions = {
  /** The rows selected in the active column; a menu on one of them acts on all. */
  selectedIds?: readonly string[]
  /** Starts the inline "new folder" row in a folder the browser owns. */
  onNewFolderIn?: (parentPageId: string | null) => void
  /** Opens the hidden file input for this folder; the input lives with the host. */
  onUploadFiles?: (parentPageId: string | null) => void
  /** The root column's "New shared folder…" — a dialog, because visibility. */
  onCreateRootFolder?: () => void
  /** Asks a virtual column's query again; it has no other way to be refreshed. */
  onRefresh?: () => void
  /**
   * The destination picker "Move to…" opens — 2D's `MoveToDialog`, injected
   * rather than imported so the menu owns *when* it opens and the transfer
   * wave owns what it does. Without it the item is absent, never inert.
   */
  renderMoveTo?: (request: FinderMoveToRequest) => ReactNode
}

/** What the menu knows about a move when it hands it to the picker. */
export type FinderMoveToRequest = {
  currentParentPageId: string | null
  onClose: () => void
  open: true
  pages: KnowledgePageRecord[]
  sourceSpaceId: string
}

type ActiveTarget =
  | { kind: 'pages'; pages: KnowledgePageRecord[] }
  | { kind: 'virtual'; row: FinderVirtualRow }
  | { kind: 'root'; row: FinderRootRow }
  | {
      kind: 'background'
      column: Exclude<FinderMenuColumnRef, { parentPageId: string | null; spaceId: string }>
    }

type FinderDialogState =
  | {
      kind: 'info'
      target: GetInfoTarget
      pageId?: string
      spaceId?: string
      indexing?: KnowledgeIndexingState
    }
  | {
      kind: 'share'
      pageId: string
      spaceId?: string
      title: string
      subjectKind: 'folder' | 'document' | 'file'
    }
  | {
      kind: 'readout'
      access: KnowledgeAccessSummary
      projectName?: string | null
      spaceId?: string
      pageId?: string
    }
  | { kind: 'delete'; pages: KnowledgePageRecord[] }
  | { kind: 'move'; pages: KnowledgePageRecord[] }
  | null

export const useFinderMenus = ({
  onCreateRootFolder,
  onNewFolderIn,
  onRefresh,
  onUploadFiles,
  renderMoveTo,
  selectedIds = [],
}: UseFinderMenusOptions = {}): FinderMenus => {
  const knowledge = useKnowledge()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const { pushToast } = useToasts()
  const menu = useContextMenu()
  const rename = useRenamePage()
  const reindex = useReindexPage()
  const removeShare = useRemovePageShare()

  const [active, setActive] = useState<ActiveTarget | null>(null)
  const [dialog, setDialog] = useState<FinderDialogState>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // The row the gesture landed on, and the list it sits in. Focus returns to
  // the row; when the row is gone — it was just deleted, or renamed into a new
  // element — it lands on the list instead, so the keyboard walk keeps its
  // place rather than starting again at the top of the page.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const fallbackFocusRef = useRef<HTMLElement | null>(null)

  const space = knowledge.selectedSpace
  const spacePersonal = space?.metadata?.personal === true
  const ownPersonal = spacePersonal && space?.userId === me?.user.id

  const openMenu = useCallback(
    (next: ActiveTarget, event: ReactMouseEvent<HTMLElement>) => {
      const element = event.currentTarget
      returnFocusRef.current = element
      fallbackFocusRef.current = element.closest<HTMLElement>(
        '[role="listbox"], .finder-drop-body',
      )
      setActive(next)
      menu.openAt(event)
    },
    [menu],
  )

  const closeMenu = useCallback(() => {
    menu.close()
    setActive(null)
  }, [menu])

  // ── What the current target is, in the builder's terms ───────────────────
  const targetPages = useMemo((): KnowledgePageRecord[] => {
    if (active?.kind !== 'pages') return []
    return active.pages
  }, [active])

  const menuTarget = useMemo((): FinderMenuTarget | null => {
    if (!active) return null
    switch (active.kind) {
      case 'pages':
        return active.pages.length > 1
          ? {
            kind: 'selection',
            pages: active.pages.map((page) => ({
              id: page.id,
              kind: page.kind as 'folder' | 'document' | 'file',
              status: page.status,
              title: page.title,
            })),
          }
          : active.pages[0]
            ? {
              kind: 'page',
              page: {
                id: active.pages[0].id,
                indexing: active.pages[0].indexing,
                kind: active.pages[0].kind as 'folder' | 'document' | 'file',
                status: active.pages[0].status,
                taskId: (active.pages[0].metadata?.taskId as string | undefined) ?? null,
                title: active.pages[0].title,
              },
              virtual: false,
            }
            : null
      case 'virtual':
        return {
          kind: 'page',
          page: {
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
        return {
          column: active.column.kind === 'folder' ? 'folder' : active.column.kind,
          kind: 'background',
        }
    }
  }, [active])

  // ── The sharing branch: grant or read-out ───────────────────────────────
  const accessFor = useCallback((): KnowledgeAccessSummary | null => {
    if (active?.kind === 'virtual' && active.row.access) {
      return {
        access: active.row.access,
        mode: 'shared_to_me',
        sharedByUserId: active.row.sharedByUserId ?? '',
      }
    }
    return space ? spaceAccessSummary(space, ownPersonal) : null
  }, [active, ownPersonal, space])

  const openSharing = useCallback(() => {
    const access = accessFor()
    const mode = access?.mode ?? 'unknown'
    const page = active?.kind === 'pages'
      ? active.pages[0]
      : active?.kind === 'virtual'
        ? active.row
        : undefined
    // The one branch the owner asked for: a personal document he may grant, or
    // a read-out of who is already in there.
    if (page && sharingSurfaceFor(mode, ownPersonal) === 'grant') {
      setDialog({
        kind: 'share',
        pageId: page.id,
        spaceId: space?.id,
        subjectKind: (page.kind === 'folder' ? 'folder' : page.kind === 'file' ? 'file' : 'document'),
        title: page.title,
      })
      return
    }
    if (access) {
      setDialog({
        access,
        kind: 'readout',
        pageId: page?.id,
        projectName: space?.name ?? null,
        spaceId: space?.id,
      })
    }
  }, [accessFor, active, ownPersonal, space])

  // ── The handler bag, bound to whatever the gesture landed on ────────────
  const handlers = useMemo((): FinderMenuHandlers => {
    const first = targetPages[0]
    const virtualRow = active?.kind === 'virtual' ? active.row : undefined
    const rootRow = active?.kind === 'root' ? active.row : undefined
    const parentPageId = active?.kind === 'background' && active.column.kind === 'folder'
      ? active.column.parentPageId
      : first?.parentPageId ?? null
    const spaceId = first?.spaceId ?? space?.id ?? ''

    const infoTarget = (): GetInfoTarget | null => {
      if (first) return { kind: 'page', pageId: first.id, title: first.title }
      if (virtualRow) return { kind: 'page', pageId: virtualRow.id, title: virtualRow.title }
      if (rootRow && rootRow.kind === 'space') {
        return { kind: 'space', spaceId: rootRow.space.spaceId, title: rootRow.space.name }
      }
      return space ? { kind: 'space', spaceId: space.id, title: space.name } : null
    }

    return {
      copyLink: () => {
        const id = first?.id ?? virtualRow?.id
        const target = virtualRow?.home.spaceId ?? spaceId
        if (!id || !target) return
        const kind = first?.kind ?? virtualRow?.kind
        void navigator.clipboard?.writeText(pageLink(target, id, kind === 'folder'))
        pushToast({ body: '', title: 'Link copied' })
      },
      download: () => {
        for (const page of targetPages.length > 0 ? targetPages : []) {
          if (page.kind !== 'file') continue
          const version = page.publishedVersion ?? page.latestVersion
          if (version) {
            window.open(
              `/api/knowledge-base/pages/${page.id}/versions/${version.id}/download`,
              '_blank',
              'noopener',
            )
          }
        }
      },
      getInfo: () => {
        const target = infoTarget()
        if (target) {
          setDialog({
            indexing: first?.indexing ?? virtualRow?.indexing,
            kind: 'info',
            pageId: first?.id ?? virtualRow?.id,
            spaceId: space?.id,
            target,
          })
        }
      },
      moveTo: renderMoveTo
        ? () => {
          if (targetPages.length > 0) setDialog({ kind: 'move', pages: targetPages })
        }
        : undefined,
      newDocument: () => knowledge.openCreate(parentPageId),
      newDocumentInside: () => knowledge.openCreate(first?.id ?? null),
      newFolder: onNewFolderIn ? () => onNewFolderIn(parentPageId) : undefined,
      newFolderInside: () => {
        if (first && onNewFolderIn) {
          knowledge.browseTo([...knowledge.pagePath, first.id])
          onNewFolderIn(first.id)
        }
      },
      newSharedFolder: onCreateRootFolder,
      open: () => {
        if (first) knowledge.openPagePath([...knowledge.pagePath, first.id])
        else if (virtualRow) {
          knowledge.openPageDeepLink({ pageId: virtualRow.id, spaceId: virtualRow.home.spaceId })
        }
      },
      openAgent: () => {
        const agentId = rootRow?.kind === 'space' ? rootRow.space.ownerAgentId : null
        if (agentId) void navigate(`/agents/${agentId}`)
      },
      openEditor: () => {
        if (first) knowledge.openEdit(first)
      },
      openProject: () => {
        const projectId = rootRow?.kind === 'space' ? rootRow.space.projectId : space?.projectId
        if (projectId) void navigate(`/projects/${projectId}`)
      },
      openTicket: () => {
        const taskId = first?.metadata?.taskId as string | undefined
        const projectId = space?.projectId
        if (taskId && projectId) {
          void navigate(`/projects/${projectId}/board?task=${encodeURIComponent(taskId)}`)
        }
      },
      publish: () => {
        if (first) knowledge.publishPage(first.id)
      },
      refresh: () => {
        // A virtual folder has no other way to be asked again, so Refresh is
        // never absent: without a host handler it invalidates the two reads a
        // column is drawn from itself.
        if (onRefresh) return onRefresh()
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.root })
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.latest() })
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.sharedWithMe })
        if (space?.id) {
          void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(space.id) })
        }
      },
      remove: () => {
        if (targetPages.length > 0) setDialog({ kind: 'delete', pages: targetPages })
      },
      removeShare: () => {
        if (virtualRow && me?.user.id) {
          removeShare.mutate({ granteeUserId: me.user.id, pageId: virtualRow.id })
        }
      },
      rename: () => setRenamingId(first?.id ?? virtualRow?.id ?? null),
      retryIndexing: () => {
        const id = first?.id ?? virtualRow?.id
        if (id) reindex.mutate(id)
        pushToast({ body: '', title: 'Indexing again…' })
      },
      sharing: openSharing,
      showInFolder: () => {
        if (!virtualRow) return
        const folder = virtualRow.home.parentPath.at(-1)?.id ?? ''
        void navigate(
          `/knowledge-base/spaces/${encodeURIComponent(virtualRow.home.spaceId)}`
          + (folder ? `?folder=${encodeURIComponent(folder)}` : ''),
        )
      },
      spaceSettings: () => knowledge.openSpaceSettings(),
      uploadFiles: onUploadFiles ? () => onUploadFiles(parentPageId) : undefined,
      uploadVersion: () => {
        // The file-version dialog belongs to the document pane, where the
        // uploader and its progress already live; opening the file is the
        // shortest honest route to it rather than a second uploader here.
        if (first) knowledge.openPagePath([...knowledge.pagePath, first.id])
      },
      versionHistory: () => {
        const id = first?.id ?? virtualRow?.id
        if (id) knowledge.openHistory(id)
      },
    }
  }, [
    active, knowledge, me?.user.id, navigate, onCreateRootFolder, onNewFolderIn, onRefresh,
    onUploadFiles, openSharing, pushToast, queryClient, reindex, removeShare, renderMoveTo,
    space, targetPages,
  ])

  const items = useMemo(() => (menuTarget
    ? buildFinderMenu({
      capabilities: {
        accessMode: accessFor()?.mode ?? 'unknown',
        actorIsPerson: true,
        canManageAccess: space?.canManageAccess ?? false,
        canShare: ownPersonal,
        canWrite: space?.canWrite ?? false,
      },
      handlers,
      target: menuTarget,
    })
    : []), [accessFor, handlers, menuTarget, ownPersonal, space])

  // ── rowProps / backgroundProps ──────────────────────────────────────────
  const renameProps = useCallback((pageId: string): FinderRowRename | undefined => {
    if (renamingId !== pageId) return undefined
    const page = knowledge.pageById(pageId)
    return {
      onCancel: () => setRenamingId(null),
      onSubmit: (next) => {
        setRenamingId(null)
        rename.mutate({
          pageId,
          revision: page?.revision,
          spaceId: page?.spaceId ?? space?.id ?? '',
          title: next,
        })
      },
      pending: rename.isPending,
    }
  }, [knowledge, rename, renamingId, space])

  const rowProps = useCallback((input: FinderMenuRowRef): FinderRowMenuProps => {
    const row = asRowRef(input)
    switch (row.kind) {
      case 'page':
        return {
          onContextMenu: (event) => {
            // A right-click inside a selection acts on the selection; on a row
            // outside it, on that row alone — Finder's own rule, and the one
            // that stops a menu quietly acting on rows nobody can see.
            const pages = selectedIds.includes(row.page.id) && selectedIds.length > 1
              ? selectedIds
                .map((id) => knowledge.pageById(id))
                .filter((page): page is KnowledgePageRecord => Boolean(page))
              : [row.page]
            openMenu({ kind: 'pages', pages }, event)
          },
          rename: renameProps(row.page.id),
        }
      case 'virtual':
        return {
          onContextMenu: (event) => openMenu({ kind: 'virtual', row: row.row }, event),
        }
      case 'root':
        return {
          onContextMenu: (event) => openMenu({ kind: 'root', row: row.row }, event),
        }
    }
  }, [knowledge, openMenu, renameProps, selectedIds])

  const backgroundProps = useCallback(
    (column: FinderMenuColumnRef): FinderBackgroundMenuProps => ({
      onContextMenu: (event) => openMenu(
        { column: asColumnRef(column), kind: 'background' },
        event,
      ),
    }),
    [openMenu],
  )

  const confirm = dialog?.kind === 'delete' ? deleteConfirmCopy(dialog.pages) : null

  const dialogs = (
    <>
      <ContextMenu
        anchor={menu.anchor}
        fallbackFocusRef={fallbackFocusRef}
        items={items}
        label={menuTarget ? finderMenuLabel(menuTarget) : 'Actions'}
        onClose={closeMenu}
        returnFocusRef={returnFocusRef}
      />
      {dialog?.kind === 'info' ? (
        <GetInfoDialog
          indexing={dialog.indexing}
          onBrowseHome={({ folderId, spaceId }) => {
            setDialog(null)
            void navigate(
              `/knowledge-base/spaces/${encodeURIComponent(spaceId)}`
              + (folderId ? `?folder=${encodeURIComponent(folderId)}` : ''),
            )
          }}
          onClose={() => setDialog(null)}
          onRetryIndexing={dialog.pageId ? () => reindex.mutate(dialog.pageId as string) : undefined}
          onSharing={() => {
            setDialog(null)
            openSharing()
          }}
          open
          target={dialog.target}
        />
      ) : null}
      {dialog?.kind === 'share' ? (
        <ShareDialog
          onClose={() => setDialog(null)}
          onCopyLink={() => {
            void navigator.clipboard?.writeText(
              pageLink(dialog.spaceId ?? '', dialog.pageId, dialog.subjectKind === 'folder'),
            )
            pushToast({ body: '', title: 'Link copied' })
          }}
          open
          pageId={dialog.pageId}
          spaceId={dialog.spaceId}
          subjectKind={dialog.subjectKind}
          title={dialog.title}
        />
      ) : null}
      {dialog?.kind === 'readout' ? (
        <AccessReadoutDialog
          access={dialog.access}
          onClose={() => setDialog(null)}
          onOpenAgent={() => {
            const agentId = space?.ownerAgentId
            if (agentId) void navigate(`/agents/${agentId}`)
          }}
          onOpenProjectMembers={() => {
            if (space?.projectId) void navigate(`/projects/${space.projectId}?tab=members`)
          }}
          onRemoveShare={dialog.pageId && me?.user.id
            ? () => {
              removeShare.mutate({
                granteeUserId: me.user.id,
                pageId: dialog.pageId as string,
              })
              setDialog(null)
            }
            : undefined}
          onSpaceSettings={() => {
            setDialog(null)
            knowledge.openSpaceSettings()
          }}
          open
          projectName={dialog.projectName}
        />
      ) : null}
      {dialog?.kind === 'move' && renderMoveTo
        ? renderMoveTo({
          currentParentPageId: dialog.pages[0]?.parentPageId ?? null,
          onClose: () => setDialog(null),
          open: true,
          pages: dialog.pages,
          sourceSpaceId: dialog.pages[0]?.spaceId ?? space?.id ?? '',
        })
        : null}
      {confirm ? (
        <ConfirmDialog
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const pages = dialog?.kind === 'delete' ? dialog.pages : []
            setDialog(null)
            void Promise.all(pages.map((page) => knowledge.archivePage(page.id)))
          }}
          open
          pending={knowledge.archivePending}
          title={confirm.title}
        />
      ) : null}
    </>
  )

  return { backgroundProps, dialogs, rowProps }
}

/** A root row, reduced to what decides its menu. */
const rootRowDescriptor = (row: FinderRootRow): FinderMenuRootRow => {
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
