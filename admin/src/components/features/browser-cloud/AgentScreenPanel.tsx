import { useCallback, useState } from 'react'

import type { AgentRecord } from '../../../lib/api-client'
import { useSidePanelGeometry } from '../../../hooks/useSidePanelGeometry'
import { LOCAL_BACK_PRIORITY, useLocalBack } from '../../../navigation/LocalBackContext'
import { useNavigationLayout } from '../../../navigation/mobile-shell'
import { PhoneBackButton } from '../../../navigation/PhoneBackButton'
import { useNativeBarHeader } from '../../../navigation/useNativeBarHeader'
import { OverlayPortal } from '../../overlays/OverlayPortal'
import { useOverlay } from '../../overlays/useOverlay'
import { SidePanelShell } from '../channels/side-panel/SidePanelShell'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { AgentScreenViewer } from './AgentScreenViewer'

/**
 * One width whichever face the column is wearing — the live viewer or the
 * idle card — so a browser starting up never moves a column the reader had
 * already sized.
 */
export const SCREEN_PANEL_WIDTH_STORAGE_KEY = 'nessie.agentScreenPanelWidth'

type AgentScreenPanelProps = {
  /** The live session to watch. `null` is the honest, common case: idle. */
  sessionId: string | null
  onClose: () => void
  agent: AgentRecord
}

/**
 * The agent's browser, beside the conversation.
 *
 * It reads exactly like a reply thread — same shell, same breakpoints, same
 * drag-resize — because it answers the same shape of question ("what is
 * happening over there") and a second set of panel mechanics would drift.
 * Tapping the expand control takes it full-screen, which is where a person
 * actually watches a browser.
 *
 * The tool rail's Browser button is persistent, so most of the time it is
 * pressed there is no session to watch — and "nothing to watch" is not
 * "nothing to know". Idle, the column answers what this browser *is*: the
 * account it runs on, what it stays signed in to, and the way to sign it out,
 * which is `AgentBrowserPanel` — the very panel the agent's own page renders,
 * never a second one. The swap is by session, so a browser starting up turns
 * the card into the screen with no further thought from the caller.
 */
export const AgentScreenPanel = ({ agent, sessionId, onClose }: AgentScreenPanelProps) => {
  const geometry = useSidePanelGeometry(SCREEN_PANEL_WIDTH_STORAGE_KEY)
  const phoneLayout = useNavigationLayout() === 'single'
  const [fullscreen, setFullscreen] = useState(false)

  // The takeover is full-bleed rather than a centred card, so it is not the
  // shared `Dialog` — but it owes the same shared work every overlay does
  // once: Back registration, Escape, the focus trap, the modal layer and its
  // motion (docs/navigation/overview.md §7).
  const exitFullscreen = useCallback(() => setFullscreen(false), [])
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
  // The tool rail opens this column from component state rather than a route,
  // so on a single-column layout it is the panel — not the router — that owes
  // Back an answer. The full-screen layer registers its own at modal priority,
  // which outranks this one, so the two never fight.
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
    back: { label: 'Back to channel', onBack: onClose },
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
            <AgentScreenViewer agent={agent} sessionId={sessionId} variant="fullscreen" />
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
          <PhoneBackButton label="Back to channel" onBack={onClose} />
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
            aria-label="Close browser"
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
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="px-1 pb-3 text-sm text-[color:var(--tx2)]">
            Not browsing right now — this column becomes {agent.name}’s screen the
            moment it opens a page.
          </p>
          {/*
            * A system-managed agent's browser record is deliberately not
            * readable through `GET /api/agents/:id/browser` — the whole agent
            * route family refuses one — so the Personal Assistant gets the
            * sentence alone rather than a card that can only fail. Watching it
            * live is unaffected: sessions are read per thread.
            */}
          {agent.systemManaged ? null : <AgentBrowserPanel agent={agent} heading={false} />}
        </div>
      ) : (
        <AgentScreenViewer agent={agent} sessionId={sessionId} variant="panel" />
      )}
    </SidePanelShell>
  )
}
