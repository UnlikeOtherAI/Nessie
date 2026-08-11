import { useNavigate } from 'react-router-dom'
import { useDeepWaterResearchRuns } from '../../../facades/integrations/hooks'
import { DeepWaterRunHistory } from '../integrations/DeepWaterRunHistory'
import { KnowledgePane } from './KnowledgePane'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

const CenteredNote = ({ title, body }: { title: string; body: string }) => (
  <div className="mx-auto max-w-md px-6 py-16 text-center">
    <h3 className="text-sm font-semibold text-[color:var(--tx)]">{title}</h3>
    <p className="mt-2 text-sm leading-6 text-[color:var(--tx3)]">{body}</p>
  </div>
)

// DeepWater's "Research" Documents view: a read surface over the team's durable
// research runs. It reuses the presentational `DeepWaterRunHistory` (the same
// list the Integrations panel renders) fed by `useDeepWaterResearchRuns()` — no
// fork of the DeepWater service or list logic. Registered into
// `product-documents-registry` under the `deep-water-research` view key.
export const DeepWaterResearchView = () => {
  const navigate = useNavigate()
  const runsQuery = useDeepWaterResearchRuns()
  const runs = runsQuery.data ?? []

  const body = runsQuery.isError ? (
    <CenteredNote
      title="DeepWater isn’t connected"
      body="Connect DeepWater from Integrations to launch research and see your runs here."
    />
  ) : !runsQuery.isLoading && runs.length === 0 ? (
    <CenteredNote
      title="No researches yet"
      body="Launch a DeepWater research from Integrations and it will appear here."
    />
  ) : (
    <div className="mx-auto w-full max-w-3xl px-6 pb-8">
      <DeepWaterRunHistory loading={runsQuery.isLoading} runs={runs} />
    </div>
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
