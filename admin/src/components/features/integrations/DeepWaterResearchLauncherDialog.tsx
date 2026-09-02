import { useCallback } from 'react'
import type {
  DeepWaterResearchLauncherPreset,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { useDeepWaterAgentAccess } from '../../../facades/integrations/hooks'
import { useOverlay } from '../../overlays/useOverlay'
import { DeepWaterResearchLauncher } from './DeepWaterResearchLauncher'

type DeepWaterResearchLauncherDialogProps = {
  initialValues?: DeepWaterResearchLauncherPreset
  onClose: () => void
  onLaunched: (channelId: string) => void
  open: boolean
  product: IntegratedProductResponse
}

const readinessMessage = ({
  connectorReady,
  personalAssistantReady,
  teamReady,
}: {
  connectorReady: boolean
  personalAssistantReady: boolean
  teamReady: boolean
}): string | undefined => {
  if (!teamReady) return 'An organization owner must enable Deep Water for this team first.'
  if (!connectorReady) return 'The team’s Ledger MCP connector is not active yet.'
  if (!personalAssistantReady) {
    return 'An organization owner must grant the Personal Assistant all six Deep Water tools.'
  }
  return undefined
}

// Chat cards never start metered work by themselves. They open this reviewable
// modal, optionally carrying a validated preset, and the person can change any
// field before explicitly starting the authorized launcher flow.
export const DeepWaterResearchLauncherDialog = ({
  initialValues,
  onClose,
  onLaunched,
  open,
  product,
}: DeepWaterResearchLauncherDialogProps) => {
  const close = useCallback(() => onClose(), [onClose])
  const overlay = useOverlay({
    id: 'deep-water-research-launcher',
    kind: 'modal',
    label: 'Close research launcher',
    onClose: close,
    open,
  })
  const accessQuery = useDeepWaterAgentAccess(open)
  const teamReady = product.teamEnablement?.enabled === true
  const connectorReady = product.mcpInstallation?.lifecycleState === 'active'
  const personalAssistantReady = accessQuery.data?.personalAssistant?.enabled === true
  const canLaunch = teamReady && connectorReady && personalAssistantReady

  if (!overlay.mounted) {
    return null
  }

  return (
    // Not the shared `Dialog`: a `max-w-3xl` / `--panel` / `shadow-2xl` card with
    // a `text-base` heading and a sticky in-scroll header, a different panel
    // family from the shell's `.create-channel-panel`. `useOverlay` still gives
    // it the Back registration, focus trap, drag-safe scrim and layer every
    // other overlay gets (docs/navigation.md §7).
    <div
      {...overlay.scrimProps}
      className="fixed inset-0 flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
      style={overlay.layerStyle}
    >
      <div
        aria-describedby="deep-water-launcher-description"
        aria-labelledby="deep-water-launcher-title"
        aria-modal="true"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-xl border border-[var(--sep)] bg-[var(--panel)] shadow-2xl"
        ref={overlay.panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--sep)] bg-[var(--panel)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--tx)]" id="deep-water-launcher-title">
              New Deep Water research
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--tx2)]" id="deep-water-launcher-description">
              Ask the question, choose how deep to go, and review it before the run is sent
              to Ledger.
            </p>
          </div>
          <button
            aria-label="Close research launcher"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]"
            onClick={close}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="p-5">
          <DeepWaterResearchLauncher
            canLaunch={canLaunch}
            initialValues={initialValues}
            onLaunched={(response) => {
              close()
              onLaunched(response.channel.id)
            }}
            readinessMessage={
              accessQuery.isLoading
                ? 'Checking Deep Water access…'
                : readinessMessage({ connectorReady, personalAssistantReady, teamReady })
            }
          />
        </div>
      </div>
    </div>
  )
}
