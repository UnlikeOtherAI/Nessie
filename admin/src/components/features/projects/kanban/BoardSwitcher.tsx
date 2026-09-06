import type { BoardRecord } from '../../../../facades/boards/hooks'
import { TabBar } from '../../../primitives/TabBar'

type BoardSwitcherProps = {
  boards: BoardRecord[]
  activeBoardId: string
  onSelect: (boardId: string) => void
}

/**
 * Which board of this project is on screen — on the single-column layout only.
 *
 * On every wider layout the Projects sidebar is pinned beside the board and
 * already draws each board as a row, so a strip here would be a second doorway
 * to one choice and the reader would have to guess which one moved them. The
 * single-column layout has no pinned sidebar and the board screen's leading
 * doorway is Back, so without this strip a phone could not reach a project's
 * second board at all (AGENTS.md → "Rule zero").
 *
 * The shared `TabBar` — boards are tabs of one screen, not routes of their
 * own, so the choice rides in `?board=` written with `replace` and Back leaves
 * the project rather than walking the boards somebody looked at. A project
 * with one board shows no strip: a single-choice selector names no decision.
 */
export const BoardSwitcher = ({ boards, activeBoardId, onSelect }: BoardSwitcherProps) => {
  if (boards.length < 2) return null
  return (
    <TabBar
      ariaLabel="Boards"
      idPrefix="project-board"
      items={boards.map((board) => ({
        label: board.name,
        testId: `board-tab-${board.id}`,
        value: board.id,
      }))}
      onChange={onSelect}
      role="tablist"
      size="sm"
      value={activeBoardId}
    />
  )
}
