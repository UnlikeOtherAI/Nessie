import { RedirectRoute } from './RedirectRoute'

/**
 * Project → Settings `?section=labels` from before labels belonged to a board
 * (board-labels-and-attachment-removal.md §8.9). An old link, a bookmark or a
 * note in a ticket still lands somewhere useful: the default board's Labels
 * tab, which is where a label that used to be the project's now lives. With no
 * default board to name, the boards directory is the next step in.
 *
 * The page resolves the default board (navigation reads no facade); this only
 * says where that takes the reader.
 */
export const LegacyProjectLabelsRedirect = ({
  defaultBoardId,
  projectId,
}: {
  defaultBoardId: string | null
  projectId: string
}) => (
  <RedirectRoute
    to={defaultBoardId
      ? `/projects/${projectId}/boards/${encodeURIComponent(defaultBoardId)}/settings?tab=labels`
      : `/projects/${projectId}/boards`}
  />
)
