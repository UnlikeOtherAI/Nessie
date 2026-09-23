import type { DeepWaterBriefOriginRequest, DeepWaterResearchRunView } from '@nessie/schemas'
import { useResearchRunList } from '../../../facades/deep-water/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { EmptyState } from '../../shared/EmptyState'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import {
  STATUS_LABEL,
  STATUS_TONE,
  formatResearchDate,
  researchName,
} from '../deep-water/research-presentation'
import { ResearchBriefHost, useResearchBriefDoorway } from '../deep-water/ResearchBriefHost'
import { ResearchRunBody } from '../deep-water/ResearchRunBody'
import { KnowledgePane } from './KnowledgePane'

/**
 * Knowledge › Research (`/knowledge-base/views/deep-water-research`): every
 * DeepWater research this person may see, newest first — the ones they asked
 * for, the ones an agent started for them, and the launched research of the
 * conversations they are in. The list is the viewer's own read; the server
 * leaves out what they may not see, and nothing here filters it again.
 *
 * Each row is the research card's own body, so its status, its artifacts and
 * the way into its brief read the same here as in the thread. A brief opens
 * over this view (`?research=<runId>`); "New research" starts one whose result
 * comes back to the person's Personal Assistant conversation. The list stays
 * current through the shell's `integration.run.updated` handler.
 */

const PERSONAL_ORIGIN: DeepWaterBriefOriginRequest = { kind: 'personal' }

export const DeepWaterResearchView = () => (
  <ResearchBriefHost origin={PERSONAL_ORIGIN}>
    <ResearchList />
  </ResearchBriefHost>
)

const rowSubtitle = (run: DeepWaterResearchRunView): string =>
  [
    formatResearchDate(run.createdAt),
    run.origin.kind === 'agent' ? 'Started by an agent' : null,
  ].filter(Boolean).join(' · ')

const ResearchList = () => {
  const { me } = useAuthSession()
  const doorway = useResearchBriefDoorway()
  const list = useResearchRunList()
  const openNew = doorway.openNew

  const actions: PageHeaderAction[] = openNew
    ? [{ id: 'new-research', label: 'New research', onSelect: () => openNew(), primary: true, priority: 100 }]
    : []

  return (
    <KnowledgePane actions={actions} title="Research">
      <QueryState
        className="py-16"
        errorLabel="Your research couldn’t be loaded."
        loadingLabel="Loading research…"
        query={list.query}
      >
        {() =>
          list.items.length === 0 && list.page === 0 ? (
            <div className="mx-auto max-w-md px-6 py-16">
              <EmptyState title="No research yet">
                Research you start here or from a conversation — and research an agent starts for you — appears
                here.
              </EmptyState>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl px-[var(--page-gutter)] pb-8" data-testid="research-list">
              <RowList label="Research">
                {list.items.map((run) => (
                  <Row
                    data={{ 'data-research-run': run.id }}
                    key={run.id}
                    subtitle={rowSubtitle(run)}
                    title={researchName(run)}
                    trailing={(
                      <Pill size="sm" tone={STATUS_TONE[run.status]} uppercase={false}>
                        {STATUS_LABEL[run.status]}
                      </Pill>
                    )}
                  >
                    <div className="mt-2">
                      <ResearchRunBody meUserId={me?.user.id ?? null} run={run} />
                    </div>
                  </Row>
                ))}
              </RowList>
              <PaginationFooter
                canNext={list.canNext}
                canPrevious={list.canPrevious}
                className="mt-3"
                hideWhenSinglePage
                label={list.label}
                onPageChange={list.onPageChange}
                onPageSizeChange={list.onPageSizeChange}
                page={list.page}
                pageCount={list.pageCount}
                pageSize={list.pageSize}
              />
            </div>
          )
        }
      </QueryState>
    </KnowledgePane>
  )
}
