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
  contractOutdated,
  personalAssistantReady,
  teamReady,
}: {
  connectorReady: boolean
  contractOutdated: boolean
  personalAssistantReady: boolean
  teamReady: boolean
}): string | undefined => {
  if (!teamReady) return 'An organisation owner must enable Deep Water for this team first.'
  if (!connectorReady) return 'Deep Water is not connected for this team yet.'
  if (contractOutdated) {
    return 'An organisation owner must update Deep Water for this team by enabling it again.'
  }
  if (!personalAssistantReady) {
    return 'An organisation owner must grant the Personal Assistant every Deep Water tool.'
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
  const contractOutdated = accessQuery.data?.contractOutdated === true
  const personalAssistantReady = accessQuery.data?.personalAssistant?.enabled === true
  const canLaunch = teamReady && connectorReady && !contractOutdated && personalAssistantReady

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
            : readinessMessage({ connectorReady, contractOutdated, personalAssistantReady, teamReady })
        }
      />
    </Dialog>
  )
}
