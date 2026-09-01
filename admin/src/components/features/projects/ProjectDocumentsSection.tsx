import { Link, useNavigate } from 'react-router-dom'
import { useProjectRecentPages } from '../../../facades/knowledge/recent-pages-hooks'
import {
  DashboardSectionCard,
  SectionNotice,
  SectionSkeleton,
  dashboardRowClass,
} from './DashboardSectionCard'
import { formatRelativeAge } from './project-dashboard-data'

type ProjectDocumentsSectionProps = {
  className?: string
  projectId: string
}

/**
 * What was last written down. The Docs tab is the working surface; this answers
 * "what changed lately", which the Docs tab can only answer by opening every
 * space by hand. Rows deep-link straight into that tab.
 */
export const ProjectDocumentsSection = ({
  className,
  projectId,
}: ProjectDocumentsSectionProps) => {
  const navigate = useNavigate()
  const docsHref = `/projects/${projectId}/docs`
  const { data: pages, isError, isPending } = useProjectRecentPages(projectId)

  return (
    <DashboardSectionCard
      className={className}
      links={[{ label: 'Open docs', to: docsHref }]}
      title="Documents"
    >
      {isPending ? <SectionSkeleton /> : null}
      {isError ? (
        <SectionNotice>Recent documents could not be loaded. Please refresh.</SectionNotice>
      ) : null}
      {!isPending && !isError && (pages ?? []).length === 0 ? (
        <SectionNotice>
          No documents yet.{' '}
          <Link className="text-[color:var(--tx2)] hover:text-[color:var(--tx)]" to={docsHref}>
            Open Docs
          </Link>{' '}
          to create this project’s first space.
        </SectionNotice>
      ) : null}
      {(pages ?? []).map((page) => (
        <button
          className={dashboardRowClass}
          key={page.id}
          onClick={() =>
            navigate(`${docsHref}?spaceId=${encodeURIComponent(page.spaceId)}`
              + `&pageId=${encodeURIComponent(page.id)}`)
          }
          type="button"
        >
          <span aria-hidden="true" className="w-4 text-center">
            {page.kind === 'file' ? '📎' : '📄'}
          </span>
          <span className="truncate text-sm text-[color:var(--tx)]">{page.title}</span>
          <span className="truncate text-xs text-[color:var(--tx3)]">{page.spaceName}</span>
          <span className="ml-auto whitespace-nowrap text-xs text-[color:var(--tx3)]">
            {formatRelativeAge(page.updatedAt)}
          </span>
        </button>
      ))}
    </DashboardSectionCard>
  )
}
