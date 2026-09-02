import { useNavigate } from 'react-router-dom'
import { useDeepWaterResearchRuns } from '../../../facades/integrations/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import { DeepWaterRunHistory } from '../integrations/DeepWaterRunHistory'
import { KnowledgePane } from './KnowledgePane'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

// DeepWater's "Research" Documents view: a read surface over the team's durable
// research runs. It reuses the presentational `DeepWaterRunHistory` (the same
// list the Integrations panel renders) fed by `useDeepWaterResearchRuns()` — no
// fork of the DeepWater service or list logic. Registered into
// `product-documents-registry` under the `deep-water-research` view key.
export const DeepWaterResearchView = () => {
  const navigate = useNavigate()
  const runsQuery = useDeepWaterResearchRuns()
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
              Launch a DeepWater research from Integrations and it will appear here.
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

  return (
    <KnowledgePane
      actions={[
        {
          id: 'new-research',
          label: 'New research',
          onSelect: () => void navigate('/settings/integrations'),
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
      title="Research"
    >
      {body}
    </KnowledgePane>
  )
}
