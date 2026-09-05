import { ProjectAgentsSection } from './ProjectAgentsSection'
import { ProjectChannelsSection } from './ProjectChannelsSection'
import { ProjectDocumentsSection } from './ProjectDocumentsSection'
import { ProjectMembersSection } from './ProjectMembersSection'
import { ProjectWorkSection } from './ProjectWorkSection'

type ProjectDashboardProps = {
  projectId: string
}

// One card of the wall. The margin is the row gap: `gap` on a multi-column
// container is the *column* gap only, so vertical spacing has to come from the
// items, and `break-inside` keeps a card whole rather than letting a column
// boundary cut a channel list in half.
const cardClass = 'mb-4 break-inside-avoid'

/**
 * The project dashboard: one component behind both entry points
 * (`/channels/projects/:id` and the Projects section's Overview tab). It renders
 * no header of its own — each host already has one.
 *
 * It is a page, so it is **full-width** (`docs/standards/design-system.md`, "One
 * page edge"): one shared `--page-gutter` on each side, and no centred
 * `max-w-*` reading column leaving a dead strip on the right. It used to cap
 * itself at 1040px and centre, which on a wide screen left the team's overview
 * floating in the middle of an empty page while every other screen in the admin
 * ran edge to edge.
 *
 * The sections are a multi-column wall rather than a fixed left/right pair.
 * `columns` derives its count from the room the element actually has, which is
 * what this screen needs: the same dashboard sits behind a chat shell on one
 * route and a full-width project tab on another, so the viewport says nothing
 * useful about the space available — and unlike a breakpoint, the count keeps
 * growing on a very wide window instead of stretching five compact cards across
 * 1600px. DOM order is urgency order (Work, Channels, Documents, Members,
 * Agents) and columns fill top-to-bottom, so that order survives at every count,
 * down to the single column a phone gets.
 */
export const ProjectDashboard = ({ projectId }: ProjectDashboardProps) => (
  <div className="h-full overflow-y-auto px-[var(--page-gutter)] py-5">
    <div className="columns-[22rem] gap-4">
      <ProjectWorkSection className={cardClass} projectId={projectId} />
      <ProjectChannelsSection className={cardClass} projectId={projectId} />
      <ProjectDocumentsSection className={cardClass} projectId={projectId} />
      <ProjectMembersSection className={cardClass} projectId={projectId} />
      <ProjectAgentsSection className={cardClass} projectId={projectId} />
    </div>
  </div>
)
