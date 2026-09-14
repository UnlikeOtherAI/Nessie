/**
 * How a board draws its tickets. `cards` is the full card — key, excerpt,
 * fields, assignee, due date; `lines` is one row per ticket carrying only the
 * title and the priority signal, so a long column can be scanned at a glance.
 * Like the assignee filter it is a view over the board, not part of it, so it
 * lives in the URL (`?view=lines`) rather than on `Board`.
 */
export type BoardView = 'cards' | 'lines'

export const DEFAULT_BOARD_VIEW: BoardView = 'cards'

export const parseBoardView = (raw: string | null): BoardView =>
  raw === 'lines' ? 'lines' : DEFAULT_BOARD_VIEW
