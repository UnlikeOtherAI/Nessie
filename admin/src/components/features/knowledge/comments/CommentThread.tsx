import { useState } from 'react'
import type { KnowledgeAnnotationRecord } from '../../../../facades/knowledge/comment-hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { UserAvatar } from '../../../primitives/UserAvatar'
import { CommentActions } from './CommentActions'
import { CommentComposer } from './CommentComposer'
import type { AuthorResolver } from './useAnnotationAuthors'
import type { AnnotationActions } from './useAnnotationActions'

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()

type RowProps = {
  annotation: KnowledgeAnnotationRecord
  currentUserId?: string
  token: string | null
  resolveAuthor: AuthorResolver
  actions: AnnotationActions
  topLevel: boolean
  onReply: () => void
}

// One comment/note/reply rendered like a channel message: avatar, author, time,
// body, and the hover action bar (reactions + reply/resolve/edit/delete).
const CommentRow = ({
  annotation,
  currentUserId,
  token,
  resolveAuthor,
  actions,
  topLevel,
  onReply,
}: RowProps) => {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const author = resolveAuthor(annotation.authorType, annotation.authorId)
  const isOwn = annotation.authorType === 'user' && annotation.authorId === currentUserId
  const resolved = annotation.state === 'resolved'

  return (
    <div
      aria-label={`Comment by ${author.displayName} — actions`}
      className="admin-msg-row relative"
      data-actions-open={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        // Keyboard parity with the click toggle, and (via :focus-within) makes
        // the Reply/Resolve/Edit/Delete/React bar reachable by keyboard/touch.
        // Only respond when the row itself is focused, never a child control.
        if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
          event.preventDefault()
          setOpen((value) => !value)
        }
      }}
      role="group"
      tabIndex={0}
    >
      <UserAvatar
        avatarAttachmentId={author.avatarAttachmentId}
        avatarUrl={author.avatarUrl}
        displayName={author.displayName}
        gravatarUrl={author.gravatarUrl}
        size={36}
        token={token}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-bold text-[var(--tx)]">{author.displayName}</span>
          {author.isAgent ? (
            <span className="rounded bg-[var(--overlay-weak)] px-1 text-[10px] uppercase text-[color:var(--tx3)]">
              agent
            </span>
          ) : null}
          <span className="text-xs text-[color:var(--tx3)]">{when(annotation.createdAt)}</span>
          {annotation.editedAt ? (
            <span className="text-xs text-[color:var(--tx3)]">(edited)</span>
          ) : null}
          {topLevel && resolved ? (
            <span className="text-xs text-[var(--success-text)]">Resolved</span>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1" onClick={stop}>
            <CommentComposer
              initialValue={annotation.body}
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                await actions.edit(annotation.id, body)
                setEditing(false)
              }}
              pending={actions.pending}
              submitLabel="Save"
            />
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-[color:var(--tx)]">{annotation.body}</p>
        )}
        <CommentActions
          canModify={isOwn}
          currentUserId={currentUserId}
          onDelete={() => actions.remove(annotation.id)}
          onEdit={() => setEditing(true)}
          onReply={onReply}
          onResolveToggle={() => actions.setState(annotation.id, resolved ? 'open' : 'resolved')}
          onToggleReaction={(emoji) => actions.toggleReaction(annotation.id, emoji)}
          reactions={annotation.reactions}
          resolved={resolved}
          topLevel={topLevel}
        />
      </div>
    </div>
  )
}

type CommentThreadProps = {
  annotation: KnowledgeAnnotationRecord
  currentUserId?: string
  authorLabel: AuthorResolver
  actions: AnnotationActions
  showAnchorQuote?: boolean
}

// A top-level comment or note plus its replies, in channel-chat style.
export const CommentThread = ({
  annotation,
  currentUserId,
  authorLabel,
  actions,
  showAnchorQuote,
}: CommentThreadProps) => {
  const { token } = useAuthSession()
  const [replying, setReplying] = useState(false)

  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--sep)] py-1">
      {showAnchorQuote && annotation.anchor ? (
        <blockquote className="mx-5 mb-1 border-l-2 border-[color:var(--accent)] pl-2 text-xs italic text-[color:var(--tx2)]">
          “{annotation.anchor.quote}”
          {annotation.orphaned ? (
            <span className="ml-2 not-italic text-[color:var(--warning-text)]">· orphaned</span>
          ) : null}
        </blockquote>
      ) : null}
      <CommentRow
        actions={actions}
        annotation={annotation}
        currentUserId={currentUserId}
        onReply={() => setReplying((value) => !value)}
        resolveAuthor={authorLabel}
        token={token}
        topLevel
      />
      {annotation.replies.length ? (
        <div className="ml-7 border-l border-[color:var(--sep)]">
          {annotation.replies.map((reply) => (
            <CommentRow
              actions={actions}
              annotation={reply}
              currentUserId={currentUserId}
              key={reply.id}
              onReply={() => setReplying(true)}
              resolveAuthor={authorLabel}
              token={token}
              topLevel={false}
            />
          ))}
        </div>
      ) : null}
      {replying ? (
        <div className="px-5 py-2" onClick={stop}>
          <CommentComposer
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await actions.reply(annotation.id, body)
              setReplying(false)
            }}
            pending={actions.pending}
            placeholder="Write a reply…"
            submitLabel="Reply"
          />
        </div>
      ) : null}
    </div>
  )
}
