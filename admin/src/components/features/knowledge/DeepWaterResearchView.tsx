import { Link } from 'react-router-dom'
import { useDeepWaterResearchRuns } from '../../../facades/integrations/hooks'
import { DeepWaterRunHistory } from '../integrations/DeepWaterRunHistory'
import { KnowledgePane } from './KnowledgePane'

// "New research" deep-links to the Integrations page, where the DeepWater
// launch panel (DeepWaterResearchPanel) lives — this view is a read surface, so
// launching stays with its existing owner rather than being rebuilt here.
const NewResearchAction = () => (
  <Link
    className="admin-button admin-button-secondary admin-button-compact h-8"
    to="/settings/integrations"
  >
    New research
  </Link>
)

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
    <KnowledgePane title="Research" actions={<NewResearchAction />}>
      {body}
    </KnowledgePane>
  )
}
