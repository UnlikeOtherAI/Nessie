import { ModelAvailabilitySettings } from '../../components/features/inference-models/ModelAvailabilitySettings'
import { OrganizationAdministrationGate } from '../settings/OrganizationAdministrationGate'

/**
 * AI models: which of the deployment's models the organisation offers for new
 * selections. A team narrows the same list from its own page.
 */
export const ModelsPage = () => (
  <OrganizationAdministrationGate host={{ title: 'AI models' }}>
    <ModelAvailabilitySettings />
  </OrganizationAdministrationGate>
)
