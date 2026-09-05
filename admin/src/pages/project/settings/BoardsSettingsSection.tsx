import { useState } from 'react'
import type { BoardRecord, BoardStyle } from '../../../facades/boards/hooks'
import { useDeleteBoard, useUpdateBoard } from '../../../facades/boards/hooks'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { Input, Select } from '../../../components/shared/FormControls'
import { Section } from '../../../components/shared/PageBody'
import { BoardColumnsEditor } from './BoardColumnsEditor'
import { BoardCreateDialog } from './BoardCreateDialog'

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback

type BoardsSettingsSectionProps = {
  boards: BoardRecord[]
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  onSelectBoard: (boardId: string) => void
  projectId: string
  selectedBoardId: string
  startWithNewBoard: boolean
}

/**
 * Every board of the project, and the columns of the one selected.
 *
 * The board list is the owning surface for creating, renaming, restyling,
 * re-defaulting and deleting a board; the board tab's header menu is the
 * in-context doorway to it.
 */
export const BoardsSettingsSection = ({
  boards,
  canAdminister,
  onSaveError,
  onSaved,
  onSelectBoard,
  projectId,
  selectedBoardId,
  startWithNewBoard,
}: BoardsSettingsSectionProps) => {
  const updateBoard = useUpdateBoard(projectId)
  const deleteBoard = useDeleteBoard(projectId)
  const [createOpen, setCreateOpen] = useState(startWithNewBoard)
  const [deleteTarget, setDeleteTarget] = useState<BoardRecord | null>(null)
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({})

  const selected = boards.find((board) => board.id === selectedBoardId) ?? boards[0] ?? null

  const commitRename = (board: BoardRecord) => {
    const trimmed = (renameDraft[board.id] ?? board.name).trim()
    if (!trimmed || trimmed === board.name) return
    updateBoard.mutate(
      { id: board.id, name: trimmed },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not rename board')),
        onSuccess: onSaved,
      },
    )
  }

  const confirmDelete = (board: BoardRecord) => {
    // Deleting the default board has to name its replacement, so the project
    // is never left without a board to open on.
    const replacement = boards.find((other) => other.id !== board.id)
    deleteBoard.mutate(
      {
        id: board.id,
        ...(board.isDefault && replacement ? { newDefaultBoardId: replacement.id } : {}),
      },
      {
        onError: (cause) => onSaveError(errorMessage(cause, 'Could not delete board')),
        onSuccess: () => {
          if (board.id === selectedBoardId && replacement) onSelectBoard(replacement.id)
          onSaved()
        },
      },
    )
  }

  return (
    <>
      <Section
        description="A board is a saved way of looking at this project's work. Every board sees
          the same tasks; deleting one deletes no work."
        title="Boards"
      >
        <div className="grid gap-1">
          {boards.map((board) => (
            <div
              className="flex items-center gap-2 rounded-md px-2 py-1.5
                data-[selected=true]:bg-[color:var(--overlay)]"
              data-selected={board.id === selected?.id}
              key={board.id}
            >
              <button
                className="min-w-0 flex-1 text-left text-sm text-[color:var(--tx)]"
                onClick={() => onSelectBoard(board.id)}
                type="button"
              >
                {board.name}
              </button>
              <span className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                {board.style === 'scrum' ? 'Iterations' : 'Kanban'}
              </span>
              <span className="text-xs text-[color:var(--tx3)]">
                {board.columns.length} columns
              </span>
              {board.isDefault ? (
                <span className="text-xs text-[color:var(--tx2)]">Default</span>
              ) : canAdminister ? (
                <button
                  className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                  onClick={() =>
                    updateBoard.mutate(
                      { id: board.id, isDefault: true },
                      {
                        onError: (cause) =>
                          onSaveError(errorMessage(cause, 'Could not set the default board')),
                        onSuccess: onSaved,
                      },
                    )
                  }
                  type="button"
                >
                  Make default
                </button>
              ) : null}
              {canAdminister && boards.length > 1 ? (
                <button
                  className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                  onClick={() => setDeleteTarget(board)}
                  type="button"
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>

        {canAdminister ? (
          <div className="border-t border-[color:var(--sep)] pt-3">
            <button
              className="admin-button admin-button-primary admin-button-compact"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              New board
            </button>
          </div>
        ) : null}
      </Section>

      {selected ? (
        <Section
          description="Each column maps to a lifecycle stage so agents and approvals keep working.
            A board with no column for a stage simply does not show that work."
          title={`“${selected.name}” columns`}
        >
          {canAdminister ? (
            <div className="flex items-center gap-2 pb-2">
              <Input
                aria-label="Board name"
                className="min-w-0 flex-1"
                onBlur={() => commitRename(selected)}
                onChange={(event) =>
                  setRenameDraft((draft) => ({ ...draft, [selected.id]: event.target.value }))
                }
                size="compact"
                value={renameDraft[selected.id] ?? selected.name}
              />
              <Select
                aria-label="Board style"
                className="max-w-[180px]"
                onChange={(event) =>
                  updateBoard.mutate(
                    { id: selected.id, style: event.target.value as BoardStyle },
                    {
                      onError: (cause) =>
                        onSaveError(errorMessage(cause, 'Could not change board style')),
                      onSuccess: onSaved,
                    },
                  )
                }
                size="compact"
                value={selected.style}
              >
                <option value="kanban">Kanban</option>
                <option value="scrum">Iterations (Scrum)</option>
              </Select>
            </div>
          ) : null}

          {canAdminister ? (
            <BoardColumnsEditor
              boardId={selected.id}
              columns={selected.columns}
              onSaveError={onSaveError}
              onSaved={onSaved}
              projectId={projectId}
            />
          ) : (
            <div className="grid gap-1 text-sm text-[color:var(--tx2)]">
              {[...selected.columns]
                .sort((a, b) => a.position - b.position)
                .map((column) => (
                  <div key={column.id}>{column.name}</div>
                ))}
            </div>
          )}
        </Section>
      ) : null}

      <BoardCreateDialog
        boards={boards}
        onClose={() => setCreateOpen(false)}
        onCreated={onSelectBoard}
        open={createOpen}
        projectId={projectId}
      />

      <ConfirmDialog
        body="Its columns and card positions go with it. The tasks stay in the project and
          keep appearing on its other boards."
        confirmLabel="Delete board"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget
          setDeleteTarget(null)
          if (target) confirmDelete(target)
        }}
        open={deleteTarget !== null}
        title={`Delete board “${deleteTarget?.name ?? ''}”?`}
      />
    </>
  )
}
