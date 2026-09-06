import { useState } from 'react'
import type { BoardRecord, BoardStyle } from '../../../../facades/boards/hooks'
import { useCreateBoard } from '../../../../facades/boards/hooks'
import { ChoiceGroup } from '../../../shared/ChoiceGroup'
import { Dialog } from '../../../shared/Dialog'
import { FormError } from '../../../shared/FormActions'
import { Input, Select } from '../../../shared/FormControls'
import { FormField } from '../../../shared/FormField'
import { BoardIconField } from './BoardIconField'

type BoardCreateDialogProps = {
  boards: BoardRecord[]
  onClose: () => void
  /** The board as the server made it — the caller needs `isDefault` to link to it. */
  onCreated: (board: BoardRecord) => void
  open: boolean
  projectId: string
}

const DEFAULT_COLUMNS = 'defaults'

/**
 * A new board, with its own tickets and its own columns. Starting from another
 * board's columns is the common case — a second board is usually a variation on
 * the first, and retyping four columns to get there is the kind of friction
 * that stops people making the board they wanted.
 */
export const BoardCreateDialog = ({
  boards,
  onClose,
  onCreated,
  open,
  projectId,
}: BoardCreateDialogProps) => {
  const createBoard = useCreateBoard(projectId)
  const [name, setName] = useState('')
  const [iconEmoji, setIconEmoji] = useState<string | null>(null)
  const [style, setStyle] = useState<BoardStyle>('kanban')
  const [columnSource, setColumnSource] = useState<string>(DEFAULT_COLUMNS)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setName('')
    setIconEmoji(null)
    setStyle('kanban')
    setColumnSource(DEFAULT_COLUMNS)
    setError(null)
    onClose()
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    createBoard.mutate(
      {
        name: trimmed,
        ...(iconEmoji ? { iconEmoji } : {}),
        style,
        ...(columnSource === DEFAULT_COLUMNS
          ? {}
          : { copyColumnsFromBoardId: columnSource }),
      },
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not create the board'),
        onSuccess: (board) => {
          onCreated(board)
          close()
        },
      },
    )
  }

  return (
    <Dialog
      description="A board of its own: its own columns, and only the tickets put on it."
      onClose={close}
      open={open}
      title="New board"
    >
      <div className="grid gap-4">
        <FormField
          help="The icon is how the board is listed in the Projects sidebar."
          label="Name"
        >
          <div className="flex items-center gap-2">
            <BoardIconField
              disabled={createBoard.isPending}
              iconEmoji={iconEmoji}
              onChange={setIconEmoji}
            />
            <Input
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              placeholder="Dev board"
              value={name}
            />
          </div>
        </FormField>

        <FormField
          help="Kanban is a continuous board. Iterations adds time-boxed sprints."
          label="Style"
        >
          <ChoiceGroup
            label="Board style"
            labelHidden
            onChange={setStyle}
            options={[
              { label: 'Kanban', value: 'kanban' },
              { label: 'Iterations (Scrum)', value: 'scrum' },
            ]}
            value={style}
          />
        </FormField>

        <FormField label="Columns">
          <Select
            aria-label="Starting columns"
            onChange={(event) => setColumnSource(event.target.value)}
            value={columnSource}
          >
            <option value={DEFAULT_COLUMNS}>Start with the default columns</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                Copy columns from “{board.name}”
              </option>
            ))}
          </Select>
        </FormField>

        <FormError>{error ?? undefined}</FormError>

        <div className="flex justify-end gap-2">
          <button className="admin-button" onClick={close} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || createBoard.isPending}
            onClick={submit}
            type="button"
          >
            Create board
          </button>
        </div>
      </div>
    </Dialog>
  )
}
