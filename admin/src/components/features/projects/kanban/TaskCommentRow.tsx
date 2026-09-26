import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { faEllipsis, faPen, faTrash } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskAttachmentRecord, TaskCommentRecord } from '@nessie/schemas'
import { IdentityTile } from '../../../primitives/IdentityTile'
import { Pill } from '../../../primitives/Pill'
import { ContextMenu } from '../../../overlays/ContextMenu'
import { useContextMenu } from '../../../overlays/useContextMenu'
import { useActorNames } from '../../../shared/ActorName'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { MessageAttachments } from '../../../shared/MessageAttachments'
import { UserAvatar } from '../../../shared/UserAvatar'
import { MarkdownEditor } from '../../../shared/markdown-editor/MarkdownEditor'
import { MessageMarkdown } from '../../channels/MessageMarkdown'
import { PROVIDER_LABEL, type BoardSourceProvider } from '../../../../facades/board-sources/hooks'
import { useDeleteTaskComment, useUpdateTaskComment } from '../../../../facades/task-comments/hooks'
import type { AttachmentRecord } from '../../../../lib/uploads'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'

/** "3 min ago" — the row's glance; the exact time rides on `title`. */
export const relativeTime = (iso: string, now = Date.now(), t?: TFunction<'projects'>, locale?: string): string => {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return ''
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return t ? t('comments.relative.justNow') : 'just now'
  if (minutes < 60) return t
    ? t('comments.relative.minutes', { count: minutes })
    : `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t
    ? t('comments.relative.hours', { count: hours })
    : `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return t
    ? t('comments.relative.days', { count: days })
    : `${days} d ago`
  return new Date(iso).toLocaleDateString(locale)
}

export const exactTime = (iso: string, locale?: string): string => new Date(iso).toLocaleString(locale)

/**
 * A provider as an author or an uploader: its initial on a neutral tile. The
 * provider is not a person and not an agent, so it gets neither of their
 * pictures — the tile says "this came from outside".
 */
export const ProviderTile = ({ provider, size = 28 }: { provider: BoardSourceProvider; size?: number }) => (
  <IdentityTile
    background="var(--overlay)"
    color="var(--tx2)"
    fallback={{ kind: 'initials', text: PROVIDER_LABEL[provider].slice(0, 1) }}
    imageUrl={null}
    label={PROVIDER_LABEL[provider]}
    size={size}
  />
)

/**
 * A ticket file as the chat renderer's record, so a comment's files reuse the
 * chat's previews and download chips instead of a second renderer.
 */
export const asAttachmentRecord = (attachment: TaskAttachmentRecord): AttachmentRecord => ({
  createdAt: attachment.createdAt,
  filename: attachment.filename,
  hasThumbnail: attachment.hasThumbnail,
  height: attachment.height ?? undefined,
  id: attachment.id,
  kind: attachment.kind,
  mime: attachment.mime,
  organizationId: '',
  sizeBytes: attachment.sizeBytes,
  uploaderId: attachment.uploaderUserId ?? undefined,
  width: attachment.width ?? undefined,
})

type TaskCommentRowProps = {
  comment: TaskCommentRecord
  /** The ticket mirrors a source: a comment with no `external` stays in Nessie. */
  mirrored: boolean
  onOpenAttachment: (attachment: AttachmentRecord) => void
  taskId: string
}

const iconButtonClass = [
  'flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
].join(' ')

/**
 * One comment: who, when, what — and Edit / Delete only where the server said
 * this viewer may (`viewerCanEdit` / `viewerCanDelete`, never re-derived here).
 */
export const TaskCommentRow = ({ comment, mirrored, onOpenAttachment, taskId }: TaskCommentRowProps) => {
  const { t, i18n } = useTranslation('projects')
  const { token } = useAuthSession()
  const resolveActor = useActorNames()
  const menu = useContextMenu()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const updateComment = useUpdateTaskComment(taskId)
  const deleteComment = useDeleteTaskComment(taskId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { author } = comment
  const actor = author.kind === 'user'
    ? resolveActor('user', author.userId)
    : author.kind === 'agent'
      ? resolveActor('agent', author.agentId)
      : null

  const save = () => {
    const body = draft.trim()
    if (!body || updateComment.isPending) return
    setError(null)
    updateComment.mutate(
      { body, commentId: comment.id },
      {
        onError: (cause) => setError(cause.message || t('comments.saveError')),
        onSuccess: () => setEditing(false),
      },
    )
  }

  const files = comment.attachments.filter((attachment) => !attachment.inline).map(asAttachmentRecord)
  const menuItems = [
    ...(comment.viewerCanEdit
      ? [{
          icon: faPen, id: 'edit', kind: 'item' as const, label: t('comments.edit'),
          onSelect: () => {
            setDraft(comment.body)
            setEditing(true)
          },
        }]
      : []),
    ...(comment.viewerCanDelete
      ? [{
          destructive: true, icon: faTrash, id: 'delete', kind: 'item' as const, label: t('comments.delete'),
          onSelect: () => setConfirmDelete(true),
        }]
      : []),
  ]

  return (
    <li className="flex gap-3 py-3" data-comment-id={comment.id}>
      <div className="flex-none pt-0.5">
        {author.kind === 'user' ? (
          <UserAvatar displayName={actor?.name ?? t('comments.person')} size={28} token={token} userId={author.userId} />
        ) : author.kind === 'agent' ? (
          <AgentAvatar agentId={author.agentId} size={28} token={token} />
        ) : (
          <ProviderTile provider={author.provider} />
        )}
      </div>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[color:var(--tx3)]">
          <span className="font-semibold text-[color:var(--tx)]">
            {actor ? (
              // The avatar already says person or agent; the audit-log suffix is noise here.
              <span title={actor.id}>{actor.name}</span>
            ) : author.kind === 'external' ? (
              <span title={t('comments.providerUser', { provider: PROVIDER_LABEL[author.provider], id: author.externalUserId })}>
                {author.displayName}
                <span className="font-normal text-[color:var(--tx3)]"> · {PROVIDER_LABEL[author.provider]}</span>
              </span>
            ) : null}
          </span>
          <time dateTime={comment.createdAt} title={exactTime(comment.createdAt, i18n.language)}>
            {relativeTime(comment.createdAt, Date.now(), t, i18n.language)}
          </time>
          {comment.editedAt ? <span title={exactTime(comment.editedAt, i18n.language)}>{t('comments.edited')}</span> : null}
          {comment.external ? (
            comment.external.url ? (
              <a href={comment.external.url} rel="noopener noreferrer" target="_blank">
                <Pill size="sm" tone="muted" uppercase={false}>{PROVIDER_LABEL[comment.external.provider]} ↗</Pill>
              </a>
            ) : (
              <Pill size="sm" tone="muted" uppercase={false}>{PROVIDER_LABEL[comment.external.provider]}</Pill>
            )
          ) : mirrored ? (
            <Pill size="sm" tone="muted" uppercase={false}>{t('comments.nessieOnly')}</Pill>
          ) : null}
          {menuItems.length > 0 && !editing ? (
            <button
              aria-label={t('comments.actions')}
              className={`${iconButtonClass} ml-auto`}
              onClick={(event) => menu.openFor(event.currentTarget)}
              ref={menuButtonRef}
              type="button"
            >
              <FontAwesomeIcon icon={faEllipsis} />
            </button>
          ) : null}
        </div>

        {editing ? (
          <div className="grid gap-2">
            <MarkdownEditor
              ariaLabel={t('comments.editComment')}
              autoFocus
              compact
              onChange={setDraft}
              onSubmitShortcut={save}
              value={draft}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => setEditing(false)}
                type="button"
              >
                {t('comments.cancel')}
              </button>
              <button
                className="admin-button admin-button-primary admin-button-compact"
                disabled={!draft.trim() || updateComment.isPending}
                onClick={save}
                type="button"
              >
                {t('comments.save')}
              </button>
            </div>
          </div>
        ) : (
          <div className="min-w-0 text-sm">
            <MessageMarkdown renderInlineText={(text) => text} resolveAttachmentImages>
              {comment.body}
            </MessageMarkdown>
          </div>
        )}
        {files.length > 0 ? <MessageAttachments attachments={files} onOpenAttachment={onOpenAttachment} /> : null}
        {error ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
      </div>

      <ContextMenu
        anchor={menu.anchor}
        items={menuItems}
        label={t('comments.actions')}
        layer="modal"
        onClose={menu.close}
        returnFocusRef={menuButtonRef}
      />
      <ConfirmDialog
        blocking
        body={t('comments.deleteBody')}
        confirmLabel={t('comments.delete')}
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          deleteComment.mutate(comment.id, {
            onError: (cause) => setError(cause.message || t('comments.deleteError')),
          })
        }}
        open={confirmDelete}
        title={t('comments.deleteTitle')}
      />
    </li>
  )
}
