import { useMemo, useState } from 'react'
import type { TextQuoteAnchor } from '@nessie/schemas'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import {
  useCreateNote,
  useKnowledgeAnnotations,
} from '../../../../facades/knowledge/comment-hooks'
import { CommentComposer } from '../comments/CommentComposer'
import { CommentThread } from '../comments/CommentThread'
import { useAnnotationActions } from '../comments/useAnnotationActions'
import { useAnnotationAuthors } from '../comments/useAnnotationAuthors'
import { RichTextContent } from '../RichTextContent'
import type { NoteAnchorInput } from './note-highlight-extension'

const CARD_CLASS = [
  'fixed right-6 top-24 z-40 flex max-h-[70vh] w-[340px] flex-col gap-3 overflow-y-auto',
  'rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] p-4',
  'shadow-[0_24px_60px_var(--scrim-strong)]',
].join(' ')

// Wraps the read-only reader with the inline-note experience: highlights anchored
// passages, lets the reader select text to start a note, and shows a floating
// card on the right for the hovered note (with its replies) or a new-note
// composer for a fresh selection.
export const PageNotesLayer = ({
  pageId,
  body,
  versionId,
}: {
  pageId: string
  body: string
  versionId: string | null
}) => {
  const { me } = useAuthSession()
  const { data: notes = [] } = useKnowledgeAnnotations(pageId, 'note')
  const createNote = useCreateNote(pageId)
  const actions = useAnnotationActions(pageId)
  const authorLabel = useAnnotationAuthors()
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<TextQuoteAnchor | null>(null)

  const noteInputs = useMemo<NoteAnchorInput[]>(
    () =>
      notes
        .filter((note) => note.anchor)
        .map((note) => ({
          id: note.id,
          anchor: note.anchor as TextQuoteAnchor,
          resolved: note.state === 'resolved',
        })),
    [notes],
  )
  const activeNote = notes.find((note) => note.id === activeNoteId) ?? null

  const closeCard = () => {
    setActiveNoteId(null)
    setPendingAnchor(null)
  }

  return (
    <div className="mt-6">
      <RichTextContent
        html={body}
        notes={noteInputs}
        onNoteHover={(id) => {
          setActiveNoteId(id)
          setPendingAnchor(null)
        }}
        onSelectNote={(anchor) => {
          setPendingAnchor(anchor)
          setActiveNoteId(null)
        }}
      />

      {pendingAnchor ? (
        <aside className={CARD_CLASS}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              New note
            </span>
            <button
              className="text-xs text-[color:var(--tx3)] hover:text-[var(--tx)]"
              onClick={closeCard}
              type="button"
            >
              Close
            </button>
          </div>
          <blockquote className="border-l-2 border-[color:var(--accent)] pl-2 text-xs italic text-[color:var(--tx2)]">
            “{pendingAnchor.quote}”
          </blockquote>
          <CommentComposer
            autoFocus
            onCancel={closeCard}
            onSubmit={(noteBody) => {
              createNote.mutate({ anchor: pendingAnchor, anchorVersionId: versionId, body: noteBody })
              closeCard()
            }}
            pending={createNote.isPending}
            placeholder="Write a note…"
            submitLabel="Add note"
          />
        </aside>
      ) : activeNote ? (
        <aside className={CARD_CLASS}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              Note
            </span>
            <button
              className="text-xs text-[color:var(--tx3)] hover:text-[var(--tx)]"
              onClick={closeCard}
              type="button"
            >
              Close
            </button>
          </div>
          <CommentThread
            actions={actions}
            annotation={activeNote}
            authorLabel={authorLabel}
            currentUserId={me?.user.id}
            showAnchorQuote
          />
        </aside>
      ) : null}
    </div>
  )
}
