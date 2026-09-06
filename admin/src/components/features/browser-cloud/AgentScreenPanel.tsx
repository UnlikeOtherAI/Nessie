import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { AgentRecord } from '../../../lib/api-client'
import { useSidePanelGeometry } from '../../../hooks/useSidePanelGeometry'
import { browserCloudKeys } from '../../../facades/browser-cloud/keys'
import { LOCAL_BACK_PRIORITY, useLocalBack } from '../../../navigation/LocalBackContext'
import { useNavigationLayout } from '../../../navigation/mobile-shell'
import { PhoneBackButton } from '../../../navigation/PhoneBackButton'
import { useNativeBarHeader } from '../../../navigation/useNativeBarHeader'
import { OverlayPortal } from '../../overlays/OverlayPortal'
import { useOverlay } from '../../overlays/useOverlay'
import { SidePanelShell } from '../channels/side-panel/SidePanelShell'
import { THREAD_PANEL_WIDTH_STORAGE_KEY } from '../channels/thread-panel/thread-panel-layout'
import { AgentScreenViewer } from './AgentScreenViewer'
import { BrowserLastState } from './BrowserLastState'

/**
 * One width whichever face the column is wearing — the live viewer or the
 * idle card — so a browser starting up never moves a column the reader had
 * already sized.
 */
const SCREEN_PANEL_WIDTH_STORAGE_KEY = 'nessie.agentScreenPanelWidth'

type AgentScreenPanelProps = {
  /** The live session to watch. `null` is the honest, common case: idle. */
  sessionId: string | null
  onClose: () => void
  agent: AgentRecord
  /** The conversation the column stands beside; the idle face reads through it. */
  threadId: string | null
}

/**
 * The agent's browser panel, beside the conversation.
 *
 * It reads exactly like a reply thread — same shell, same breakpoints, same
 * drag-resize — because it answers the same shape of question ("what is
 * happening over there") and a second set of panel mechanics would drift.
 * Tapping the expand control takes it full-screen, which is where a person
 * actually watches a browser.
 *
 * The tool rail's Browser button is persistent, so most of the time it is
 * pressed there is no session to watch — and "nothing to watch" is not
 * "nothing to know". Idle, the panel shows where the browser left off
 * (`BrowserLastState`: the tabs it was left with, what each showed, and the
 * window to tap). The swap is by session, so a browser starting up — the
 * agent's, or a person's — turns that into the live view with no further
 * thought from the caller.
 */
export const AgentScreenPanel = ({ agent, sessionId, onClose, threadId }: AgentScreenPanelProps) => {
  // The reply thread stands immediately to this panel's left, and the handle
  // between them belongs to this panel. The hook links the two only while
  // both are on screen, so naming the thread's key costs nothing when there
  // is no thread.
  const geometry = useSidePanelGeometry(SCREEN_PANEL_WIDTH_STORAGE_KEY, {
    linkedLeftKey: THREAD_PANEL_WIDTH_STORAGE_KEY,
  })
  const phoneLayout = useNavigationLayout() === 'single'
  const queryClient = useQueryClient()
  const [fullscreen, setFullscreen] = useState(false)
  // A resume is "open it for me": the resumed session arrives a poll later,
  // and when *that* session — not whichever the thread lists first — is the
  // one on screen, the panel goes full screen and claims the controls, which
  // is the only container where a person can drive. Held as intent rather than
  // set directly, because full screen with no session yet is an empty layer.
  const [awaitingSessionId, setAwaitingSessionId] = useState<string | null>(null)
  const [claimForPerson, setClaimForPerson] = useState(false)
  useEffect(() => {
    if (awaitingSessionId !== null && sessionId === awaitingSessionId) {
      setFullscreen(true)
      setClaimForPerson(true)
      setAwaitingSessionId(null)
    }
  }, [awaitingSessionId, sessionId])
  // Leaving full screen unmounts the viewer, whose once-guard is a ref that
  // resets on remount; a claim intent left standing would take the controls
  // again the next time the person opened full screen by hand.
  useEffect(() => {
    if (!fullscreen) setClaimForPerson(false)
  }, [fullscreen])
  // The rows behind the idle face change exactly when a session ends, and
  // the face would otherwise be served last time's tabs from the cache.
  const previousSessionId = useRef(sessionId)
  useEffect(() => {
    if (previousSessionId.current !== null && sessionId === null) {
      void queryClient.invalidateQueries({
        queryKey: browserCloudKeys.agentBrowserTabs(threadId ?? undefined, agent.id),
      })
    }
    previousSessionId.current = sessionId
  }, [agent.id, queryClient, sessionId, threadId])

  // The takeover is full-bleed rather than a centred card, so it is not the
  // shared `Dialog` — but it owes the same shared work every overlay does
  // once: Back registration, Escape, the focus trap, the modal layer and its
  // motion (docs/navigation/overview.md §7).
  const exitFullscreen = useCallback(() => setFullscreen(false), [])

  // Full screen exists to watch something. When the agent closes its browser
  // mid-watch the session goes away under us, and staying would leave a
  // full-bleed layer with a header over nothing — so it hands the reader back
  // to the column, which has an idle face to show.
  useEffect(() => {
    if (sessionId === null) setFullscreen(false)
  }, [sessionId])
  const overlay = useOverlay({
    id: 'agent-screen-fullscreen',
    kind: 'modal',
    label: 'Exit full screen',
    onClose: exitFullscreen,
    open: fullscreen,
  })

  // One instance, two shapes: the modal full-screen layer and the side panel.
  // Each publishes its own Back and its own action, and the store updates the
  // entry in place, so switching between them swaps the bar with no extra
  // coordination.
  // On a single-column layout the panel is a route and the router owns Back;
  // this registration is for the layouts in between — a narrow tablet, where
  // the shell is `split` but the panel is a full-screen layer opened from the
  // rail — so a hardware Back or an edge swipe closes the panel rather than
  // the conversation under it. The full-screen layer registers its own at
  // modal priority, which outranks this one, so the two never fight.
  useLocalBack({
    active: !overlay.mounted,
    id: 'chat-tool:browser',
    label: 'Back to conversation',
    onBack: onClose,
    priority: LOCAL_BACK_PRIORITY.chatToolPanel,
  })

  const { hidden: nativeBarOwnsHeader } = useNativeBarHeader({
    actions: sessionId === null ? [] : [{
      checked: null,
      disabled: false,
      id: 'agent-screen-fullscreen-toggle',
      items: null,
      kind: 'button' as const,
      label: overlay.mounted ? 'Exit full screen' : 'Full screen',
      perform: overlay.mounted ? overlay.requestClose : () => setFullscreen(true),
      primary: true,
      priority: 100,
      selected: overlay.mounted,
      submit: false,
      tone: null,
    }],
    back: { label: 'Back to conversation', onBack: onClose },
    title: 'Browser',
  })

  if (overlay.mounted) {
    return (
      <OverlayPortal>
        <div
          aria-label="Browser"
          aria-modal="true"
          className="fixed inset-0 flex flex-col bg-[color:var(--main)] pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]"
          ref={overlay.panelRef}
          role="dialog"
          style={overlay.layerStyle}
          tabIndex={-1}
        >
          {nativeBarOwnsHeader ? null : (
          <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[color:var(--sep)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">Browser</h2>
            <div className="flex items-center gap-2">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={overlay.requestClose}
                type="button"
              >
                Exit full screen
              </button>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={onClose}
                type="button"
              >
                Close
              </button>
            </div>
          </header>
          )}
          {sessionId === null ? null : (
            <AgentScreenViewer
              agent={agent}
              claimOnLive={claimForPerson}
              onDone={overlay.requestClose}
              sessionId={sessionId}
              threadId={threadId}
              variant="fullscreen"
            />
          )}
        </div>
      </OverlayPortal>
    )
  }

  return (
    <SidePanelShell
      ariaLabel="Browser"
      isClosing={false}
      onClose={onClose}
      panelWidth={geometry.panelWidth}
      persistPanelWidth={geometry.persistPanelWidth}
      resizePanel={geometry.resizePanel}
      resizePanelWithKeyboard={geometry.resizePanelWithKeyboard}
      viewportWidth={geometry.viewportWidth}
    >
      {nativeBarOwnsHeader ? null : (
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
        {phoneLayout ? (
          <PhoneBackButton label="Back to conversation" onBack={onClose} />
        ) : null}
        <h2 className="flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">Browser</h2>
        {sessionId === null ? null : (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => setFullscreen(true)}
            type="button"
          >
            Full screen
          </button>
        )}
        {phoneLayout ? null : (
          <button
            aria-label="Close browser panel"
            className="admin-icon-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        )}
      </header>
      )}
      {sessionId === null ? (
        <BrowserLastState
          agent={agent}
          onResumed={setAwaitingSessionId}
          opening={awaitingSessionId !== null}
          threadId={threadId}
        />
      ) : (
        <AgentScreenViewer agent={agent} sessionId={sessionId} threadId={threadId} variant="panel" />
      )}
    </SidePanelShell>
  )
}
