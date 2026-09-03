import { useCallback, useState } from 'react'

import { useSidePanelGeometry } from '../../../hooks/useSidePanelGeometry'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'
import { OverlayPortal } from '../../overlays/OverlayPortal'
import { useOverlay } from '../../overlays/useOverlay'
import { SidePanelShell } from '../channels/side-panel/SidePanelShell'
import { AgentScreenViewer } from './AgentScreenViewer'

const SCREEN_PANEL_WIDTH_STORAGE_KEY = 'nessie.agentScreenPanelWidth'

type AgentScreenPanelProps = {
  sessionId: string
  onClose: () => void
  /** Drives the shared-browser banner; absent simply omits it. */
  agent?: { id: string; visibility?: 'team' | 'private' }
}

/**
 * The agent's screen, beside the conversation.
 *
 * It reads exactly like a reply thread — same shell, same breakpoints, same
 * drag-resize — because it answers the same shape of question ("what is
 * happening over there") and a second set of panel mechanics would drift.
 * Tapping the expand control takes it full-screen, which is where a person
 * actually watches a browser.
 */
export const AgentScreenPanel = ({ agent, sessionId, onClose }: AgentScreenPanelProps) => {
  const geometry = useSidePanelGeometry(SCREEN_PANEL_WIDTH_STORAGE_KEY)
  const phoneLayout = usePhoneLayout()
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

  if (overlay.mounted) {
    return (
      <OverlayPortal>
        <div
          aria-label="Agent's screen"
          aria-modal="true"
          className="fixed inset-0 flex flex-col bg-[color:var(--main)] pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]"
          ref={overlay.panelRef}
          role="dialog"
          style={overlay.layerStyle}
          tabIndex={-1}
        >
          <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[color:var(--sep)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">Agent’s screen</h2>
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
          <AgentScreenViewer agent={agent} sessionId={sessionId} variant="fullscreen" />
        </div>
      </OverlayPortal>
    )
  }

  return (
    <SidePanelShell
      ariaLabel="Agent's screen"
      isClosing={false}
      onClose={onClose}
      panelWidth={geometry.panelWidth}
      persistPanelWidth={geometry.persistPanelWidth}
      resizePanel={geometry.resizePanel}
      resizePanelWithKeyboard={geometry.resizePanelWithKeyboard}
      viewportWidth={geometry.viewportWidth}
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
        {phoneLayout ? (
          <PhoneBackButton label="Back to channel" onBack={onClose} />
        ) : null}
        <h2 className="flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
          Agent’s screen
        </h2>
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          onClick={() => setFullscreen(true)}
          type="button"
        >
          Full screen
        </button>
        {phoneLayout ? null : (
          <button
            aria-label="Close agent's screen"
            className="admin-icon-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        )}
      </header>
      <AgentScreenViewer agent={agent} sessionId={sessionId} variant="panel" />
    </SidePanelShell>
  )
}
