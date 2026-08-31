import { useEffect, useMemo, useRef, useState } from 'react'
import { faNoteSticky } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
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
import { RichTextContent, type SelectionPoint } from '../RichTextContent'
import type { NoteAnchorInput } from './note-highlight-extension'

const RIGHT_CARD_CLASS = [
  'fixed right-6 top-24 z-40 flex max-h-[70vh] w-[340px] flex-col gap-3 overflow-y-auto',
  'rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] p-4',
  'shadow-[0_24px_60px_var(--scrim-strong)]',
].join(' ')

const POPOVER_WIDTH = 320

type PendingNote = { anchor: TextQuoteAnchor; at: SelectionPoint }

// Wraps the read-only reader with the inline-note experience: highlights anchored
// passages, opens a small popover right under a fresh text selection to add a
// note, and shows a floating card on the right for the hovered note (with its
// replies).
export const PageNotesLayer = ({
  canWrite,
  pageId,
  body,
  versionId,
}: {
  canWrite: boolean
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
  const [pending, setPending] = useState<PendingNote | null>(null)
  // Two-step note creation: a fresh selection first shows a small "Add note"
  // button that does NOT steal focus, so the user's text selection survives and
  // can be copied. Only clicking it opens the (autofocusing) composer.
  const [composing, setComposing] = useState(false)
  const addNoteRef = useRef<HTMLButtonElement>(null)

  const closeComposer = () => {
    setPending(null)
    setComposing(false)
  }

  // Dismiss the floating "Add note" button when the user clicks/selects elsewhere
  // (without stealing focus or blocking the click, so selection + copy keep working).
  useEffect(() => {
    if (!pending || composing) return
    const onDown = (event: PointerEvent) => {
      if (addNoteRef.current?.contains(event.target as Node)) return
      setPending(null)
    }
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', onDown), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [pending, composing])

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

  const popoverLeft = pending
    ? Math.min(
        Math.max(pending.at.left, POPOVER_WIDTH / 2 + 8),
        window.innerWidth - POPOVER_WIDTH / 2 - 8,
      )
    : 0

  return (
    <div className="mt-6">
      <RichTextContent
        canCreate={canWrite}
        html={body}
        notes={noteInputs}
        onNoteHover={(id) => {
          setActiveNoteId(id)
          setPending(null)
        }}
        onSelectNote={(anchor, at) => {
          if (!canWrite) return
          setPending({ anchor, at })
          setActiveNoteId(null)
          setComposing(false)
        }}
      />

      {pending && !composing ? (
        // Non-focus-stealing affordance: the text selection stays intact (so it
        // can be copied) until the user explicitly chooses to add a note.
        <button
          aria-label="Add note to selection"
          className="fixed z-50 flex items-center gap-1.5 rounded-md border border-[color:var(--sep)] bg-[color:var(--panel)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--tx)] shadow-[0_8px_24px_var(--scrim-strong)] hover:bg-[color:var(--overlay-weak)]"
          onClick={() => setComposing(true)}
          ref={addNoteRef}
          style={{
            top: `${pending.at.top + 8}px`,
            left: `${popoverLeft}px`,
            transform: 'translateX(-50%)',
          }}
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3 text-[color:var(--accent)]" icon={faNoteSticky} />
          Add note
        </button>
      ) : pending && composing ? (
        <>
          <button
            aria-label="Dismiss note composer"
            className="fixed inset-0 z-40 cursor-default"
            onClick={closeComposer}
            type="button"
          />
          <aside
            className="fixed z-50 flex flex-col gap-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 shadow-[0_16px_40px_var(--scrim-strong)]"
            style={{
              top: `${pending.at.top + 8}px`,
              left: `${popoverLeft}px`,
              width: `${POPOVER_WIDTH}px`,
              transform: 'translateX(-50%)',
            }}
          >
            <blockquote className="border-l-2 border-[color:var(--accent)] pl-2 text-xs italic text-[color:var(--tx2)]">
              “{pending.anchor.quote}”
            </blockquote>
            <CommentComposer
              autoFocus
              onCancel={closeComposer}
              onSubmit={async (noteBody) => {
                await createNote.mutateAsync({
                  anchor: pending.anchor,
                  anchorVersionId: versionId,
                  body: noteBody,
                })
                closeComposer()
              }}
              pending={createNote.isPending}
              placeholder="Write a note…"
              submitLabel="Add note"
            />
          </aside>
        </>
      ) : activeNote ? (
        <aside className={RIGHT_CARD_CLASS}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              Note
            </span>
            <button
              className="text-xs text-[color:var(--tx3)] hover:text-[var(--tx)]"
              onClick={() => setActiveNoteId(null)}
              type="button"
            >
              Close
            </button>
          </div>
          <CommentThread
            actions={actions}
            annotation={activeNote}
            authorLabel={authorLabel}
            canResolve={canWrite}
            currentUserId={me?.user.id}
            showAnchorQuote
          />
        </aside>
      ) : null}
    </div>
  )
}
