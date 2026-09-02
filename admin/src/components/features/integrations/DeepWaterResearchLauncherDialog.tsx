import type {
  DeepWaterResearchLauncherPreset,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { useDeepWaterAgentAccess } from '../../../facades/integrations/hooks'
import { Dialog } from '../../shared/Dialog'
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
  const accessQuery = useDeepWaterAgentAccess(open)
  const teamReady = product.teamEnablement?.enabled === true
  const connectorReady = product.mcpInstallation?.lifecycleState === 'active'
  const personalAssistantReady = accessQuery.data?.personalAssistant?.enabled === true
  const canLaunch = teamReady && connectorReady && personalAssistantReady

  return (
    <Dialog
      description="Ask the question, choose how deep to go, and review it before the run is sent to Ledger."
      onClose={onClose}
      open={open}
      size="xl"
      title="New Deep Water research"
    >
      <DeepWaterResearchLauncher
        canLaunch={canLaunch}
        initialValues={initialValues}
        onLaunched={(response) => {
          onClose()
          onLaunched(response.channel.id)
        }}
        readinessMessage={
          accessQuery.isLoading
            ? 'Checking Deep Water access…'
            : readinessMessage({ connectorReady, personalAssistantReady, teamReady })
        }
      />
    </Dialog>
  )
}
