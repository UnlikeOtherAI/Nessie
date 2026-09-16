import { ProjectDocumentsSection } from './ProjectDocumentsSection'
import { ProjectNavigationTiles } from './ProjectNavigationTiles'
import { ProjectWorkSection } from './ProjectWorkSection'

type ProjectDashboardProps = {
  projectId: string
}

/**
 * The project dashboard: one component behind both entry points
 * (`/channels/projects/:id` and the Projects section's Overview tab). It renders
 * no header of its own — each host already has one.
 *
 * It opens with the navigation grid, because that is what Overview is for: a
 * person arriving at a project wants to get somewhere, and a wall of read-only
 * summaries answered a question they had not asked yet. Each tile says what is
 * in it, which is what let the wall go: a project's rooms, its people and its
 * document count were a card each, and Members in particular appeared three
 * times on one screen — the header button, the tile and the card.
 *
 * What is left is the two things a count cannot say, in two columns:
 *
 *   **Where the work is** — the reader's own open tickets, or, with none of
 *   their own, what nobody has picked up. Named rather than implied; see
 *   `projectWorkQueue`.
 *   **Latest documents** — what has been written down, newest first.
 *
 * The page therefore takes the navigation's colour rather than the work
 * surface's white. The surface class is on each host's outer section, not here,
 * so the project header is painted with the body it titles rather than left as
 * a white band above it — `.admin-nav-surface` in `styles.css` says why.
 *
 * It is a page, so it is **full-width** (`docs/standards/design-system.md`, "One
 * page edge"): one shared `--page-gutter` on each side, and no centred
 * `max-w-*` reading column leaving a dead strip on the right.
 *
 * Each column is a query container of its own, so a row inside it restacks on
 * the column's width rather than the window's — this dashboard is narrow
 * behind a chat shell on a desktop and wide on a phone in landscape, and only
 * the column knows which.
 *
 * The two columns are `auto-fit` rather than a breakpoint, for the reason the
 * tile grid is: the same dashboard sits behind a chat shell on one route and a
 * full-width project tab on another, so the viewport says nothing useful about
 * the space available. With exactly two children `auto-fit` is two columns
 * where they fit and one where they do not, and never three.
 */
export const ProjectDashboard = ({ projectId }: ProjectDashboardProps) => (
  <div className="h-full overflow-y-auto px-[var(--page-gutter)] py-5">
    <ProjectNavigationTiles className="mb-5" projectId={projectId} />
    <div className="project-overview-columns">
      <div className="project-overview-column">
        <ProjectWorkSection projectId={projectId} />
      </div>
      <div className="project-overview-column">
        <ProjectDocumentsSection projectId={projectId} />
      </div>
    </div>
  </div>
)
