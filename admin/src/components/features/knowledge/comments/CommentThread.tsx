import { useState } from 'react'
import type { KnowledgeAnnotationRecord } from '../../../../facades/knowledge/comment-hooks'
import { CommentComposer } from './CommentComposer'
import type { AuthorResolver } from './useAnnotationAuthors'
import type { AnnotationActions } from './useAnnotationActions'

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type RowProps = {
  annotation: KnowledgeAnnotationRecord
  currentUserId?: string
  authorLabel: AuthorResolver
  actions: AnnotationActions
}

// One comment/note/reply body with author, time, and edit/delete for its author.
const Row = ({ annotation, currentUserId, authorLabel, actions }: RowProps) => {
  const [editing, setEditing] = useState(false)
  const isOwn = annotation.authorType === 'user' && annotation.authorId === currentUserId
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-[color:var(--tx)]">
          {authorLabel(annotation.authorType, annotation.authorId)}
        </span>
        {annotation.authorType === 'agent' ? (
          <span className="rounded bg-[var(--overlay-weak)] px-1 text-[10px] uppercase text-[color:var(--tx3)]">
            agent
          </span>
        ) : null}
        <span className="text-[color:var(--tx3)]">{when(annotation.createdAt)}</span>
        {annotation.editedAt ? <span className="text-[color:var(--tx3)]">(edited)</span> : null}
      </div>
      {editing ? (
        <CommentComposer
          initialValue={annotation.body}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => {
            actions.edit(annotation.id, body)
            setEditing(false)
          }}
          pending={actions.pending}
          submitLabel="Save"
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-[color:var(--tx)]">{annotation.body}</p>
      )}
      {isOwn && !editing ? (
        <div className="flex gap-3 text-xs text-[color:var(--tx3)]">
          <button className="hover:text-[var(--tx)]" onClick={() => setEditing(true)} type="button">
            Edit
          </button>
          <button
            className="hover:text-[var(--danger-text)]"
            onClick={() => actions.remove(annotation.id)}
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}
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

// A top-level comment or note plus its replies, with reply + resolve controls.
export const CommentThread = ({
  annotation,
  currentUserId,
  authorLabel,
  actions,
  showAnchorQuote,
}: CommentThreadProps) => {
  const [replying, setReplying] = useState(false)
  const resolved = annotation.state === 'resolved'
  return (
    <div className="flex flex-col gap-3 rounded-md border border-[color:var(--sep)] p-3">
      {showAnchorQuote && annotation.anchor ? (
        <blockquote className="border-l-2 border-[color:var(--accent)] pl-2 text-xs italic text-[color:var(--tx2)]">
          “{annotation.anchor.quote}”
          {annotation.orphaned ? (
            <span className="ml-2 not-italic text-[color:var(--warning-text)]">· orphaned</span>
          ) : null}
        </blockquote>
      ) : null}
      <Row
        actions={actions}
        annotation={annotation}
        authorLabel={authorLabel}
        currentUserId={currentUserId}
      />
      <div className="flex items-center gap-3 text-xs text-[color:var(--tx3)]">
        <button className="hover:text-[var(--tx)]" onClick={() => setReplying((v) => !v)} type="button">
          Reply
        </button>
        <button
          className="hover:text-[var(--tx)]"
          onClick={() => actions.setState(annotation.id, resolved ? 'open' : 'resolved')}
          type="button"
        >
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
        {resolved ? <span className="text-[var(--success-text)]">Resolved</span> : null}
      </div>
      {annotation.replies.length ? (
        <div className="flex flex-col gap-3 border-l border-[color:var(--sep)] pl-3">
          {annotation.replies.map((reply) => (
            <Row
              actions={actions}
              annotation={reply}
              authorLabel={authorLabel}
              currentUserId={currentUserId}
              key={reply.id}
            />
          ))}
        </div>
      ) : null}
      {replying ? (
        <CommentComposer
          autoFocus
          onCancel={() => setReplying(false)}
          onSubmit={(body) => {
            actions.reply(annotation.id, body)
            setReplying(false)
          }}
          pending={actions.pending}
          placeholder="Write a reply…"
          submitLabel="Reply"
        />
      ) : null}
    </div>
  )
}
