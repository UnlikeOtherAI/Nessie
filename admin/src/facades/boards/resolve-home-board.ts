/**
 * The board a ticket's labels live on (board-labels-and-attachment-removal.md
 * §8.1): the board it names when that board is in the list, else the
 * project's default board, else nothing yet. A task's `boardId: null` means
 * the default board, which is also where a create without a board lands.
 *
 * Pure, so it can be tabled without React: the dialog calls it with the
 * project's boards as `useProjectBoards` answers them.
 */
export const resolveHomeBoardId = (
  boards: readonly { id: string; isDefault: boolean }[] | null | undefined,
  boardId: string | null | undefined,
): string | null => {
  if (!boards || boards.length === 0) return null
  if (boardId && boards.some((board) => board.id === boardId)) return boardId
  return boards.find((board) => board.isDefault)?.id ?? null
}
