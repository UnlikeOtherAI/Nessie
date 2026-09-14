/**
 * How a board draws its tickets. `cards` is the full card — key, excerpt,
 * fields, assignee, due date; `lines` is one row per ticket carrying only the
 * title and the priority signal, so a long column can be scanned at a glance.
 * Like the assignee filter it is a view over the board, not part of it, so it
 * lives in the URL (`?view=lines`, through `useTabParam`) rather than on `Board`.
 */
export const BOARD_VIEWS = ['cards', 'lines'] as const

export type BoardView = (typeof BOARD_VIEWS)[number]

export const DEFAULT_BOARD_VIEW: BoardView = 'cards'
