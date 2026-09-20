import type { TeamRecord } from '../../../lib/api-client'
import type { SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import { ModelAvailabilitySettings } from '../OrganizationModelsPage'

/**
 * The team's view of the shared Ledger catalogue. The server intersects this
 * list with organization availability before it reaches the browser, so a
 * team can narrow its choices but cannot discover or restore an org-disabled
 * provider/model pair.
 */
export const TeamModelsPage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => {
  if (!team) return null
  return <ModelAvailabilitySettings tabs={tabs} teamId={team.id} />
}
