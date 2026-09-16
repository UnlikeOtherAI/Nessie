import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeIndexingState, KnowledgeItemInfo } from '@nessie/schemas'
import { ActorName, useActorNames } from '../../../shared/ActorName'
import { Dialog } from '../../../shared/Dialog'
import { QueryState } from '../../../shared/QueryState'
import {
  familyForFilename,
  familyLabel,
  familyTone,
  iconForFamily,
  type FileFamily,
} from '../../../shared/file-icons'
import { formatBytes } from '../../../../lib/upload-xhr'
import { usePageInfo, useSpaceInfo } from '../../../../facades/knowledge/finder-hooks'
import {
  personalReadout,
  projectReadout,
  agentReadout,
  sharedToMeReadout,
  spaceReadout,
} from './sharing-copy'

/**
 * Get Info (menus-and-dialogs.md §3): how big this is *including everything
 * inside it*, where it lives, whether it is searchable, and who can see it.
 *
 * A `Dialog`, not a `Sheet`: Get Info is a glance you dismiss, with no edit in
 * it. It reads one endpoint — the counts and the bytes are computed on read by
 * one bounded recursive walk, never maintained as a counter beside the storage
 * ledger — and every row below says plainly when that walk was capped.
 */

export type GetInfoTarget =
  | { kind: 'page'; pageId: string; title: string }
  | { kind: 'space'; spaceId: string; title: string }

type GetInfoDialogProps = {
  onClose: () => void
  /** Opens the sharing surface for this item; absent where there is none. */
  onSharing?: () => void
  /**
   * The row's own indexing state, from the listing that drew it. Get Info's
   * own `indexing` is the subtree triple — "2 not indexed" over a folder of
   * drafts is not a failure — so Retry is offered from this instead, and only
   * where the pipeline actually failed.
   */
  indexing?: KnowledgeIndexingState
  onRetryIndexing?: () => void
  /** Browse to one of the segments of the "Where" line. */
  onBrowseHome?: (input: { spaceId: string; folderId: string | null }) => void
  onOpenTicket?: (taskId: string) => void
  open: boolean
  target: GetInfoTarget
}

const formatDateTime = (value: string): string => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : value
}

const bytes = (value: string): string => formatBytes(Number(value))

/** "Folder", "PDF document", "Your documents" — what a person calls the thing. */
const familyOf = (info: KnowledgeItemInfo): FileFamily => {
  if (info.kind === 'folder' || info.kind === 'space') return 'folder'
  if (info.kind === 'document') return 'document'
  return familyForFilename(info.title)
}

const kindLabel = (info: KnowledgeItemInfo): string => {
  if (info.target === 'space') {
    switch (info.home.rootKind) {
      case 'personal': return 'Your documents'
      case 'project': return 'Project folder'
      case 'agent': return 'Agent documents'
      default: return 'Shared folder'
    }
  }
  return familyLabel[familyOf(info)]
}

const contains = (info: KnowledgeItemInfo): string | null => {
  if (info.kind !== 'folder' && info.kind !== 'space') return null
  const { documents, files, folders } = info.counts
  const parts = [
    folders > 0 ? `${folders} ${folders === 1 ? 'folder' : 'folders'}` : null,
    documents > 0 ? `${documents} ${documents === 1 ? 'document' : 'documents'}` : null,
    files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : null,
  ].filter(Boolean)
  const body = parts.length === 0 ? 'Nothing yet' : parts.join(', ')
  // A capped walk is a lower bound, and a number that might be wrong has to
  // say so where it is read, not in a tooltip.
  return info.truncated ? `${body} (counted up to 10,000 items)` : body
}

/**
 * The Search row. For one item it is the honest sentence for its state; for a
 * folder it is the triple, because "Indexing…" over a folder of 400 files
 * would be true of one of them.
 */
const searchLine = (info: KnowledgeItemInfo): string | null => {
  if (info.kind === 'folder' || info.kind === 'space') {
    const { indexed, notIndexed, pending } = info.indexing
    if (indexed + notIndexed + pending === 0) return null
    return `${indexed} searchable, ${pending} indexing, ${notIndexed} not indexed`
  }
  const { indexed, notIndexed, pending } = info.indexing
  if (pending > 0) return 'Indexing…'
  if (indexed > 0) return 'Searchable'
  if (notIndexed > 0) {
    return info.kind === 'document'
      ? 'Not indexed — draft documents are indexed when published'
      : `Not indexed — ${familyLabel[familyOf(info)]}s aren’t searchable`
  }
  return 'Preparing search…'
}

const sharingLine = (info: KnowledgeItemInfo): string => {
  const { access } = info
  switch (access.mode) {
    case 'personal':
      return personalReadout(access.shareCount).body
    case 'project':
      return projectReadout(access.projectName).headline
    case 'space':
      return spaceReadout({
        projectName: info.home.projectName,
        spaceName: access.spaceName,
        visibility: access.visibility,
        writeRestricted: access.writeRestricted,
      }).headline
    case 'agent':
      return agentReadout(access.agentName, access.memberUserCount).headline
    case 'shared_to_me':
      return sharedToMeReadout('The owner', access.access).headline
  }
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-[color:var(--tx3)]">{label}</dt>
    <dd className="min-w-0 text-[color:var(--tx)]">{children}</dd>
  </>
)

const InfoBody = ({
  info,
  onBrowseHome,
  onOpenTicket,
  onRetryIndexing,
}: {
  info: KnowledgeItemInfo
  onBrowseHome?: GetInfoDialogProps['onBrowseHome']
  onOpenTicket?: GetInfoDialogProps['onOpenTicket']
  onRetryIndexing?: () => void
}) => {
  const family = familyOf(info)
  const containsLine = contains(info)
  const search = searchLine(info)
  const resolveActor = useActorNames()
  const sizeSuffix = info.kind === 'folder' || info.kind === 'space'
    ? ` for ${info.counts.folders + info.counts.documents + info.counts.files} items`
    : ''
  const onDisk = info.storageBytes !== info.sizeBytes
    ? `${bytes(info.storageBytes)}${info.retainedVersions > 0
      ? ` including ${info.retainedVersions} earlier ${info.retainedVersions === 1 ? 'version' : 'versions'}`
      : ''}`
    : null

  return (
    <div className="grid gap-4">
      {/* The name is the dialog's own h2; a second copy beside the icon would
          be the same word twice in one glance. */}
      <FontAwesomeIcon
        aria-hidden="true"
        className="h-10 w-10"
        icon={iconForFamily(family)}
        style={{ color: `var(${familyTone[family]})` }}
      />

      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
        data-testid="get-info-list"
      >
        <Row label="Kind">{kindLabel(info)}</Row>
        <Row label="Size">{`${bytes(info.sizeBytes)}${sizeSuffix}`}</Row>
        {onDisk ? <Row label="On disk">{onDisk}</Row> : null}
        {containsLine ? <Row label="Contains">{containsLine}</Row> : null}
        {info.target === 'page' ? (
          <Row label="Where">
            <button
              className="text-left text-[color:var(--accent)] hover:underline"
              onClick={() => onBrowseHome?.({
                folderId: info.home.parentPath.at(-1)?.id ?? null,
                spaceId: info.home.spaceId,
              })}
              type="button"
            >
              {[info.home.spaceName, ...info.home.parentPath.map((crumb) => crumb.title)]
                .join(' › ')}
            </button>
          </Row>
        ) : null}
        {info.taskId ? (
          <Row label="Ticket">
            <button
              className="text-left text-[color:var(--accent)] hover:underline"
              onClick={() => onOpenTicket?.(info.taskId as string)}
              type="button"
            >
              Open the ticket this folder belongs to
            </button>
          </Row>
        ) : null}
        <Row label="Created">
          <span>
            {formatDateTime(info.createdAt)}
            {' by '}
            <ActorName actor={resolveActor('user', info.createdBy)} />
          </span>
        </Row>
        <Row label="Modified">{formatDateTime(info.updatedAt)}</Row>
        {search ? (
          <Row label="Search">
            <span className="flex flex-wrap items-center gap-2">
              {search}
              {onRetryIndexing ? (
                <button
                  className="admin-button admin-button-secondary"
                  onClick={onRetryIndexing}
                  type="button"
                >
                  <span className="text-xs">Retry</span>
                </button>
              ) : null}
            </span>
          </Row>
        ) : null}
        <Row label="Sharing">{sharingLine(info)}</Row>
      </dl>
    </div>
  )
}

export const GetInfoDialog = ({
  indexing,
  onBrowseHome,
  onClose,
  onOpenTicket,
  onRetryIndexing,
  onSharing,
  open,
  target,
}: GetInfoDialogProps) => {
  const pageQuery = usePageInfo(target.kind === 'page' && open ? target.pageId : undefined)
  const spaceQuery = useSpaceInfo(target.kind === 'space' && open ? target.spaceId : undefined)
  const query = target.kind === 'page' ? pageQuery : spaceQuery
  const info = query.data

  return (
    <Dialog onClose={onClose} open={open} title={target.title}>
      <QueryState
        className="py-6"
        errorLabel="Couldn’t read this item’s details."
        loadingLabel="Reading…"
        query={{ isError: query.isError, isLoading: query.isLoading, refetch: query.refetch }}
      >
        {() => (info ? (
          <InfoBody
            info={info}
            onBrowseHome={onBrowseHome}
            onOpenTicket={onOpenTicket}
            // Offered only where retrying is a real answer: a pipeline that
            // actually failed. "Not indexed — draft" is not a failure, and a
            // Retry beside it would promise something no retry can do.
            onRetryIndexing={indexing?.state === 'failed' ? onRetryIndexing : undefined}
          />
        ) : null)}
      </QueryState>

      <div className="flex justify-end gap-2 pt-5">
        {onSharing ? (
          <button
            className="admin-button admin-button-secondary"
            onClick={onSharing}
            type="button"
          >
            Sharing…
          </button>
        ) : null}
        <button className="admin-button admin-button-primary" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </Dialog>
  )
}
