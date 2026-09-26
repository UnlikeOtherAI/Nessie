import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskExternalLinkRecord } from '@nessie/schemas'
import { Notice } from '../../../primitives/Notice'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { Skeleton } from '../../../primitives/Skeleton'
import { useAttachmentViewer } from '../../../shared/AttachmentViewer'
import { PROVIDER_LABEL, useProjectSource } from '../../../../facades/board-sources/hooks'
import { useTaskComments } from '../../../../facades/task-comments/hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { TaskCommentComposer } from './TaskCommentComposer'
import { TaskCommentRow } from './TaskCommentRow'

type TaskCommentsSectionProps = {
  canComment: boolean
  externalLink: TaskExternalLinkRecord | null
  projectId: string | null
  taskId: string
}

/** Where a comment made here goes, on a ticket that mirrors a source. */
const AudienceLine = ({
  externalLink,
  projectId,
}: {
  externalLink: TaskExternalLinkRecord
  projectId: string | null
}) => {
  const { t } = useTranslation('projects')
  // Only a read & write source sends the comment anywhere, so only then is
  // there an owner to name.
  const source = useProjectSource(
    projectId ?? undefined,
    externalLink.writeMode === 'read_only' ? undefined : externalLink.sourceId,
  )
  const provider = PROVIDER_LABEL[externalLink.provider]
  const owner = source.data?.connectionOwnerDisplayName ?? t('comments.connectionOwner')
  return (
    <p className="text-xs text-[color:var(--tx3)]">
      {externalLink.writeMode === 'read_only'
        ? t('comments.readOnlyAudience', { provider })
        : t('comments.writeAudience', { provider, owner })}
    </p>
  )
}

/**
 * The ticket's discussion, oldest first with the composer last (ui.md §5.6).
 * `task.activity` refreshes the list, so a colleague's comment arrives
 * without a reload.
 */
export const TaskCommentsSection = ({ canComment, externalLink, projectId, taskId }: TaskCommentsSectionProps) => {
  const { t } = useTranslation('projects')
  const { token } = useAuthSession()
  const commentsQuery = useTaskComments(taskId)
  // Rendered inside the ticket dialog (a modal): see TaskAttachmentsSection.
  const { attachmentViewer, openAttachment } = useAttachmentViewer(token, { blocking: true })
  const listRef = useRef<HTMLUListElement>(null)
  const [justPosted, setJustPosted] = useState<string | null>(null)
  const { comments, total } = commentsQuery

  useEffect(() => {
    if (!justPosted) return
    const row = listRef.current?.querySelector(`[data-comment-id="${justPosted}"]`)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setJustPosted(null)
  }, [comments, justPosted])

  return (
    <section aria-label={t('comments.title')} className="grid gap-1" data-testid="task-comments">
      <SectionLabel as="span" size="sm">
        {t('comments.title')}{total > 0 ? ` · ${total}` : ''}
      </SectionLabel>

      {commentsQuery.isLoading ? (
        <Skeleton count={3} variant="feed" />
      ) : commentsQuery.isError ? (
        <Notice size="sm" tone="danger">
          {t('comments.loadError')}{' '}
          <button className="underline" onClick={() => void commentsQuery.refetch()} type="button">
            {t('comments.retry')}
          </button>
        </Notice>
      ) : comments.length === 0 ? (
        <p className="py-2 text-sm text-[color:var(--tx3)]">{t('comments.empty')}</p>
      ) : (
        <ul className="grid divide-y divide-[color:var(--sep)]" ref={listRef}>
          {comments.map((comment) => (
            <TaskCommentRow
              comment={comment}
              key={comment.id}
              mirrored={Boolean(externalLink)}
              onOpenAttachment={openAttachment}
              taskId={taskId}
            />
          ))}
        </ul>
      )}

      {commentsQuery.hasNextPage ? (
        <button
          className="justify-self-start text-xs text-[color:var(--tx2)] underline hover:text-[color:var(--tx)]"
          disabled={commentsQuery.isFetchingNextPage}
          onClick={() => void commentsQuery.fetchNextPage()}
          type="button"
        >
          {commentsQuery.isFetchingNextPage ? t('comments.loading') : t('comments.showMore')}
        </button>
      ) : null}

      {canComment ? (
        <div className="grid gap-2 pt-2">
          <TaskCommentComposer onPosted={setJustPosted} taskId={taskId} />
          {externalLink ? <AudienceLine externalLink={externalLink} projectId={projectId} /> : null}
        </div>
      ) : (
        <p className="pt-2 text-xs text-[color:var(--tx3)]">{t('comments.readOnly')}</p>
      )}
      {attachmentViewer}
    </section>
  )
}
