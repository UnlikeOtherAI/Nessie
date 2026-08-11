import { ProjectAgentsSection } from './ProjectAgentsSection'
import { ProjectChannelsSection } from './ProjectChannelsSection'
import { ProjectDocumentsSection } from './ProjectDocumentsSection'
import { ProjectMembersSection } from './ProjectMembersSection'
import { ProjectWorkSection } from './ProjectWorkSection'

type ProjectDashboardProps = {
  projectId: string
}

// Two columns above 900px of *content* width — a container query, not a
// viewport one: the same dashboard sits behind a 325px shell on one route and
// a collapsed drawer on another, so the viewport says nothing useful about the
// room it has. Below that it is one stack. The wrappers are `display: contents`
// while stacked, so the sections become direct flex items of the page and their
// `order` puts urgency first: Work, Channels, Documents, Members, Agents. Above
// the breakpoint the wrappers become the columns and each column's own order
// applies.
const leftColumn = 'contents @min-[900px]:flex @min-[900px]:min-w-0 @min-[900px]:flex-col @min-[900px]:gap-4'
const rightColumn = 'contents @min-[900px]:flex @min-[900px]:flex-col @min-[900px]:gap-4'

/**
 * The project dashboard: one component behind both entry points
 * (`/channels/projects/:id` and the Projects section's Overview tab). It renders
 * no header of its own — each host already has one.
 */
export const ProjectDashboard = ({ projectId }: ProjectDashboardProps) => (
  <div className="@container h-full overflow-y-auto">
    <div
      className={[
        'mx-auto flex max-w-[1040px] flex-col gap-4 p-6',
        '@min-[900px]:grid @min-[900px]:grid-cols-[minmax(0,1fr)_320px] @min-[900px]:items-start',
      ].join(' ')}
    >
      <div className={leftColumn}>
        <ProjectChannelsSection className="order-2" projectId={projectId} />
        <ProjectDocumentsSection className="order-3" projectId={projectId} />
      </div>
      <div className={rightColumn}>
        <ProjectWorkSection className="order-1" projectId={projectId} />
        <ProjectMembersSection className="order-4" projectId={projectId} />
        <ProjectAgentsSection className="order-5" projectId={projectId} />
      </div>
    </div>
  </div>
)
