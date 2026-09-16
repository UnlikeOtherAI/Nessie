import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { KnowledgeAccessSummary } from '@nessie/schemas'
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
import { GetInfoDialog } from './GetInfoDialog'
import { ShareDialog } from './ShareDialog'
import { useRemovePageShare } from './share-hooks'
import { sharingSurfaceFor, buildFinderMenu, finderMenuLabel } from './finder-menu'
import type { FinderMenuHandlers } from './finder-menu'
import {
  asColumnRef,
  asRowRef,
  finderMenuTargetFor,
  infoTargetFor,
  type FinderMenuActiveTarget,
  type FinderMenuColumnRef,
  type FinderMenuRowRef,
} from './finder-menu-target'
import type { FinderRowRename } from './RenameRow'
import type {
  FinderBackgroundMenuProps,
  FinderDialogState,
  FinderMenus,
  FinderRowMenuProps,
  UseFinderMenusOptions,
} from './finder-menu-types'
import { deleteConfirmCopy, pageLink, spaceAccessSummary } from './finder-menu-context'

/**
 * Right-click, everywhere in the Finder (menus-and-dialogs.md §2–§4, §8).
 *
 * One hook, mounted once by the browser, that owns the menu's anchoring and
 * focus and every dialog a menu opens. A column calls `rowProps(row)` and
 * spreads the result on its `FinderRow`, `backgroundProps(column)` on the
 * column body, and renders `dialogs` once.
 *
 * What it does *not* do is decide what the menu contains: that is
 * `buildFinderMenu`, a pure function with its own suite. This file is the
 * wiring — which page the gesture landed on, where focus goes when the row it
 * opened on has just been deleted, and which dialog a label opens.
 */

// The shapes every other wave compiles against, re-exported from the two
// modules that own them so one import path answers for all of them.
export type {
  FinderMenuActiveTarget, FinderMenuColumnRef, FinderMenuRowRef,
} from './finder-menu-target'
export type {
  FinderBackgroundMenuProps, FinderMenus, FinderMoveToRequest, FinderRowMenuProps,
  UseFinderMenusOptions,
} from './finder-menu-types'

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

  // Every write a menu starts says so when it fails: a row that silently
  // snapped back reads as a gesture that missed, not as a refusal.
  const failed = useCallback((title: string) => (error: unknown) => pushToast({
    body: error instanceof Error ? error.message : 'Please try again.',
    title,
  }), [pushToast])

  const [active, setActive] = useState<FinderMenuActiveTarget | null>(null)
  const [dialog, setDialog] = useState<FinderDialogState>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // Focus returns to the row the gesture landed on; when that row is gone it
  // lands on the list instead, so the keyboard walk keeps its place.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const fallbackFocusRef = useRef<HTMLElement | null>(null)

  const space = knowledge.selectedSpace
  const spacePersonal = space?.metadata?.personal === true
  const ownPersonal = spacePersonal && space?.userId === me?.user.id

  const openMenu = useCallback(
    (next: FinderMenuActiveTarget, event: ReactMouseEvent<HTMLElement>) => {
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
  const targetPages = useMemo(
    (): KnowledgePageRecord[] => (active?.kind === 'pages' ? active.pages : []),
    [active],
  )

  const menuTarget = useMemo(() => finderMenuTargetFor(active), [active])

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
    // The one branch the owner asked for: a document he may grant, or a
    // read-out of who is already in there.
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
        const target = infoTargetFor({ first, rootRow, space, virtualRow })
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
        // Refresh is never absent: a virtual folder has no other way to be
        // asked again, so without a host handler it invalidates the reads.
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
          removeShare.mutate(
            { granteeUserId: me.user.id, pageId: virtualRow.id },
            { onError: failed('Couldn’t remove that') },
          )
        }
      },
      rename: () => setRenamingId(first?.id ?? virtualRow?.id ?? null),
      retryIndexing: () => {
        const id = first?.id ?? virtualRow?.id
        if (!id) return
        reindex.mutate(id, { onError: failed('Couldn’t start indexing') })
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
      // The file-version dialog belongs to the document pane, where the
      // uploader and its progress already live; opening the file is the
      // shortest honest route to it rather than a second uploader here.
      uploadVersion: () => {
        if (first) knowledge.openPagePath([...knowledge.pagePath, first.id])
      },
      versionHistory: () => {
        const id = first?.id ?? virtualRow?.id
        if (id) knowledge.openHistory(id)
      },
    }
  }, [
    active, failed, knowledge, me?.user.id, navigate, onCreateRootFolder, onNewFolderIn, onRefresh,
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
        rename.mutate(
          {
            pageId,
            revision: page?.revision,
            spaceId: page?.spaceId ?? space?.id ?? '',
            title: next,
          },
          // The facade puts the old name back; this says why.
          { onError: failed('Couldn’t rename that') },
        )
      },
      pending: rename.isPending,
    }
  }, [failed, knowledge, rename, renamingId, space])

  const rowProps = useCallback((input: FinderMenuRowRef): FinderRowMenuProps => {
    const row = asRowRef(input)
    switch (row.kind) {
      case 'page':
        return {
          onContextMenu: (event) => {
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
          onRetryIndexing={dialog.pageId
            ? () => reindex.mutate(
              dialog.pageId as string,
              { onError: failed('Couldn’t start indexing') },
            )
            : undefined}
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
              removeShare.mutate(
                { granteeUserId: me.user.id, pageId: dialog.pageId as string },
                { onError: failed('Couldn’t remove that') },
              )
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
              .catch(failed('Couldn’t delete that'))
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
