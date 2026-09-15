import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDeepWaterResearchRuns, useIntegratedProducts } from '../../../facades/integrations/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import { DeepWaterResearchLauncherDialog } from '../integrations/DeepWaterResearchLauncherDialog'
import { DeepWaterRunHistory } from '../integrations/DeepWaterRunHistory'
import { KnowledgePane } from './KnowledgePane'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

// DeepWater's "Research" Documents view: a read surface over the team's durable
// research runs. It reuses the presentational `DeepWaterRunHistory` fed by
// `useDeepWaterResearchRuns()` — no fork of the DeepWater service or list logic.
// "New research" opens the same reviewable launcher dialog chat cards open.
// Registered into `product-documents-registry` under the `deep-water-research`
// view key.
export const DeepWaterResearchView = () => {
  const navigate = useNavigate()
  const runsQuery = useDeepWaterResearchRuns()
  const { data: integratedProducts = [] } = useIntegratedProducts()
  const product = integratedProducts.find((entry) => entry.slug === 'deep-water')
  const [launcherOpen, setLauncherOpen] = useState(false)
  const runs = runsQuery.data ?? []

  const body = (
    <QueryState
      className="py-16"
      errorLabel="DeepWater isn’t connected."
      loadingLabel="Loading research runs…"
      query={runsQuery}
    >
      {() =>
        runs.length === 0 ? (
          <div className="mx-auto max-w-md px-6 py-16">
            <EmptyState title="No researches yet">
              Start a new research and it will appear here.
            </EmptyState>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 pb-8">
            <DeepWaterRunHistory runs={runs} />
          </div>
        )
      }
    </QueryState>
  )

  const actions: PageHeaderAction[] = product
    ? [
        {
          id: 'new-research',
          label: 'New research',
          onSelect: () => setLauncherOpen(true),
          primary: true,
          priority: 100,
        },
      ]
    : []

  return (
    <KnowledgePane actions={actions} title="Research">
      {body}
      {product && launcherOpen ? (
        <DeepWaterResearchLauncherDialog
          onClose={() => setLauncherOpen(false)}
          onLaunched={(channelId) => void navigate(`/channels/${channelId}`)}
          open
          product={product}
        />
      ) : null}
    </KnowledgePane>
  )
}
