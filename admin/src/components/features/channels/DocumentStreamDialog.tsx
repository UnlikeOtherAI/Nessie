import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRetargetDocumentStream } from '../../../facades/threads/document-stream'
import {
  useDocumentStreamSnapshot,
  type DocumentStreamStore,
} from '../../../facades/threads/document-stream-store'
import {
  isDocumentStreamActive,
  type DocumentStreamEntry,
} from '../../../facades/threads/document-stream-entries'
import { useCancelRun } from '../../../facades/runs/hooks'
import { useCursorFollow } from '../../../hooks/useCursorFollow'
import { useLeaveGuard } from '../../../hooks/useLeaveGuard'
import { usePhoneLayout } from '../../../navigation/mobile-shell'
import { OverlayPortal } from '../../overlays/OverlayPortal'
import { useOverlay } from '../../overlays/useOverlay'
import { DocumentStreamChip } from './DocumentStreamChip'
import { DocumentStreamLeaveConfirm } from './DocumentStreamLeaveConfirm'
import { DocumentTargetBar } from './DocumentTargetBar'
import { StreamingMarkdown } from './StreamingMarkdown'

type DocumentStreamDialogProps = {
  entry: DocumentStreamEntry
  onHide: () => void
  store: DocumentStreamStore
  threadId?: string
}

const ERROR_COPY: Record<string, string> = {
  budget_stopped: 'The run stopped at its budget before the document was saved.',
  cancelled: 'You stopped this document. Nothing was saved.',
  invalid_args: 'The location for this document was not valid, so nothing was saved.',
  run_failed: 'The run failed before the document was saved.',
  save_failed: 'The document could not be saved to the knowledge base.',
  superseded: 'The agent restarted this document, so this attempt was dropped.',
  truncated: 'The document was cut short, so nothing was saved.',
}

const documentFileName = (title: string | null): string =>
  `${(title ?? 'Untitled').replace(/\.md$/i, '')}.md`

/**
 * The document popup. It opens by itself when an agent starts writing, and
 * everything in it is the writing: the text as it arrives, where the file will
 * land, and the two decisions the reader owns — keep watching or stop.
 *
 * Escape, the scrim and Hide only minimize (`onHide`): the generation keeps
 * running server-side and the chip brings it back. Only Stop cancels. While a
 * document is being written the three implicit exits (×, Escape, the scrim) ask
 * first, because none of them says which of the two they meant; the labelled
 * Hide button already does, so it does not.
 */
export const DocumentStreamDialog = ({
  entry,
  onHide,
  store,
  threadId,
}: DocumentStreamDialogProps) => {
  const phoneLayout = usePhoneLayout()
  const live = useDocumentStreamSnapshot(store, entry)
  const streaming = isDocumentStreamActive(live)

  const hide = useCallback(() => onHide(), [onHide])
  const [confirmLeave, setConfirmLeave] = useState(false)
  const requestClose = useCallback(() => {
    if (streaming) {
      setConfirmLeave(true)
      return
    }
    onHide()
  }, [onHide, streaming])
  const overlay = useOverlay({
    id: `document-stream-${entry.sessionId}`,
    kind: 'modal',
    label: 'Hide document',
    onClose: requestClose,
    open: true,
  })

  const cursorFollow = useCursorFollow({
    active: streaming,
    content: live.markdown,
    jumpKey: live.editIndex,
    resetKey: live.sessionId,
  })
  const retarget = useRetargetDocumentStream(threadId)
  const cancelRun = useCancelRun()
  const navigate = useNavigate()
  const [confirmStop, setConfirmStop] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!streaming) {
      setConfirmStop(false)
      setConfirmLeave(false)
    }
  }, [streaming])

  const stopRun = useCallback(() => {
    setActionError(null)
    cancelRun.mutate(live.runId, {
      onError: (error) => setActionError(error.message),
    })
  }, [cancelRun, live.runId])

  const result = live.result
  const errorCopy = live.errorReason ? ERROR_COPY[live.errorReason] : null

  return (
    <OverlayPortal>
      <>
        {/* Not the shared `Dialog`: it branches its scrim on phone layout (a
            full-screen sheet with no backdrop, vs. a centred card) — a decision
            the shell's one panel shape cannot express. `useOverlay` still gives
            it the Back registration, focus trap, drag-safe scrim and layer
            every other overlay gets (docs/navigation/overview.md §7). */}
        <div
          {...(phoneLayout ? {} : overlay.scrimProps)}
          className={
            phoneLayout
              ? 'fixed inset-0 bg-[color:var(--main)]'
              : 'fixed inset-0 flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm'
          }
          onKeyDown={(event) => {
            // The popup can be open over the reply panel, which closes itself on a
            // window-level Escape. Minimizing this must not close both.
            if (event.key === 'Escape') {
              event.stopPropagation()
            }
          }}
          role="presentation"
          style={overlay.layerStyle}
        >
          <div
            aria-labelledby="document-stream-title"
            aria-modal="true"
            className={[
              'flex min-h-0 flex-col overflow-hidden',
              phoneLayout
                ? 'h-[100dvh] w-full bg-[color:var(--main)] pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]'
                : 'max-h-[calc(100dvh-3rem)] w-full max-w-3xl rounded-xl border border-[color:var(--sep)] bg-[var(--panel)] shadow-2xl',
            ].join(' ')}
            data-testid="document-stream-dialog"
            ref={overlay.panelRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[color:var(--sep)] px-5 py-4">
              <div className="min-w-0">
                <h2
                  className="truncate text-base font-semibold text-[var(--tx)]"
                  id="document-stream-title"
                >
                  {live.title ?? 'Writing document…'}
                </h2>
                <p className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
                  <span data-testid="document-stream-chars">
                    {live.markdown.length.toLocaleString()} characters
                  </span>
                  {streaming ? (
                    <span aria-label="Still writing" className="thinking-dots" role="status">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : null}
                </p>
              </div>
              <button
                aria-label="Hide document"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]"
                onClick={requestClose}
                type="button"
              >
                ×
              </button>
            </header>

            <div className="relative flex min-h-0 flex-1 flex-col">
              <div
                className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                data-testid="document-stream-body"
                ref={cursorFollow.containerRef}
              >
                <div ref={cursorFollow.contentRef}>
                  {live.markdown.length === 0 ? (
                    <p className="text-sm text-[color:var(--tx3)]">
                      Waiting for the first words…
                    </p>
                  ) : (
                    <StreamingMarkdown
                      cursor={live.cursor}
                      markdown={live.markdown}
                      onCursorBlock={cursorFollow.blockRef}
                      onCursorMarker={cursorFollow.markerRef}
                      streaming={streaming}
                    />
                  )}
                </div>
              </div>
              {streaming && !cursorFollow.following ? (
                <button
                  className={[
                    'admin-button admin-button-secondary admin-button-compact',
                    'absolute bottom-3 right-5 shadow-lg',
                  ].join(' ')}
                  data-testid="document-stream-follow"
                  onClick={cursorFollow.refollow}
                  type="button"
                >
                  Follow edit
                </button>
              ) : null}
            </div>

            {errorCopy ? (
              <p
                className="flex-shrink-0 border-t border-[color:var(--sep)] px-5 py-2 text-xs text-[color:var(--danger)]"
                data-testid="document-stream-error"
              >
                {errorCopy} The text above stays here until you close it.
              </p>
            ) : null}
            {actionError ? (
              <p className="flex-shrink-0 px-5 pt-2 text-xs text-[color:var(--danger)]">
                {actionError}
              </p>
            ) : null}

            <footer className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-[color:var(--sep)] px-5 py-3">
              <DocumentTargetBar
                disabled={Boolean(errorCopy)}
                fileName={documentFileName(live.title ?? result?.title ?? null)}
                pending={retarget.isPending}
                target={live.target}
                onSelect={(input) => {
                  setActionError(null)
                  retarget.mutate(
                    { ...input, sessionId: live.sessionId },
                    {
                      onError: (error) => setActionError(error.message),
                    },
                  )
                }}
              />

              {streaming ? (
                <>
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    onClick={hide}
                    type="button"
                  >
                    Hide
                  </button>
                  {confirmStop ? (
                    <button
                      className="admin-button admin-button-danger admin-button-compact"
                      data-testid="document-stream-stop-confirm"
                      disabled={cancelRun.isPending}
                      onClick={stopRun}
                      type="button"
                    >
                      Stop — nothing is saved
                    </button>
                  ) : (
                    <button
                      className="admin-button admin-button-secondary admin-button-compact"
                      data-testid="document-stream-stop"
                      onClick={() => setConfirmStop(true)}
                      type="button"
                    >
                      Stop
                    </button>
                  )}
                </>
              ) : (
                <>
                  {result?.pageId ? (
                    <button
                      className="admin-button admin-button-primary admin-button-compact"
                      data-testid="document-stream-open"
                      onClick={() => {
                        navigate(
                          `/knowledge-base?spaceId=${encodeURIComponent(result.spaceId)}` +
                            `&pageId=${encodeURIComponent(result.pageId)}`,
                        )
                        hide()
                      }}
                      type="button"
                    >
                      Open document
                    </button>
                  ) : null}
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    onClick={hide}
                    type="button"
                  >
                    Close
                  </button>
                </>
              )}
            </footer>
          </div>
        </div>
        {confirmLeave ? (
          <DocumentStreamLeaveConfirm
            mode="close"
            stopPending={cancelRun.isPending}
            title={live.title}
            onCancel={() => setConfirmLeave(false)}
            onProceed={() => {
              setConfirmLeave(false)
              hide()
            }}
            onStop={stopRun}
          />
        ) : null}
      </>
    </OverlayPortal>
  )
}

/**
 * Owns the popup for a feed, mirroring `useThoughtProcessDialog`'s seam so the
 * channel feed and the reply panel share one implementation.
 *
 * A session opens its popup once, by itself, the moment it announces itself.
 * After that the reader is in charge: hiding it leaves a chip and never
 * re-opens it, because a popup that keeps reappearing is a popup you cannot
 * read past.
 *
 * It also owns the leave guard, because the question is "is anything still
 * being written *here*" — every session of this thread, open popup or minimized
 * chip — not "is the popup open".
 */
export const useDocumentStreamDialog = (
  documentSessions: DocumentStreamEntry[],
  store: DocumentStreamStore,
  threadId?: string,
) => {
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const offeredRef = useRef(new Set<string>())
  const cancelRun = useCancelRun()

  const writing = documentSessions.filter(isDocumentStreamActive)
  const blocker = useLeaveGuard(writing.length > 0)

  useEffect(() => {
    offeredRef.current = new Set<string>()
    setOpenSessionId(null)
  }, [threadId])

  useEffect(() => {
    const fresh = documentSessions.filter(
      (session) => !offeredRef.current.has(session.sessionId),
    )
    if (fresh.length === 0) {
      return
    }
    for (const session of fresh) {
      offeredRef.current.add(session.sessionId)
    }
    const newest = [...fresh].reverse().find((session) => isDocumentStreamActive(session))
    if (newest) {
      setOpenSessionId(newest.sessionId)
    }
  }, [documentSessions])

  const openSession = useCallback((sessionId: string) => {
    offeredRef.current.add(sessionId)
    setOpenSessionId(sessionId)
  }, [])

  const entry =
    documentSessions.find((session) => session.sessionId === openSessionId) ?? null

  return {
    chips: documentSessions
      .filter((session) => session.sessionId !== openSessionId)
      .map((session) => (
        <DocumentStreamChip
          entry={session}
          key={session.sessionId}
          store={store}
          onOpen={openSession}
        />
      )),
    dialog: (
      <>
        {entry ? (
          <DocumentStreamDialog
            entry={entry}
            store={store}
            threadId={threadId}
            onHide={() => setOpenSessionId(null)}
          />
        ) : null}
        {blocker.state === 'blocked' ? (
          <DocumentStreamLeaveConfirm
            mode="navigate"
            stopPending={cancelRun.isPending}
            title={writing[0]?.title ?? null}
            onCancel={() => blocker.reset()}
            onProceed={() => blocker.proceed()}
            onStop={() => {
              // Every document still being written here — leaving with one of
              // several stopped would be the worst of both answers.
              for (const session of writing) {
                cancelRun.mutate(session.runId)
              }
              blocker.proceed()
            }}
          />
        ) : null}
      </>
    ),
    openSession,
  }
}
