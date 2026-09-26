import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('projects')
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
          onError: () => setError(t('boards.create.error')),
        onSuccess: (board) => {
          onCreated(board)
          close()
        },
      },
    )
  }

  return (
    <Dialog
      description={t('boards.create.description')}
      onClose={close}
      open={open}
      title={t('boards.create.title')}
    >
      <div className="grid gap-4">
        <FormField
          help={t('boards.create.iconHelp')}
          label={t('common.name')}
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
              placeholder={t('boards.create.placeholder')}
              value={name}
            />
          </div>
        </FormField>

        <FormField
          help={t('boards.create.styleHelp')}
          label={t('common.style')}
        >
          <ChoiceGroup
            label={t('boards.create.style')}
            labelHidden
            onChange={setStyle}
            options={[
              { label: t('boards.style.kanban'), value: 'kanban' },
              { label: t('boards.style.scrum'), value: 'scrum' },
            ]}
            value={style}
          />
        </FormField>

        <FormField label={t('boards.columns.title')}>
          <Select
            aria-label={t('boards.create.startingColumns')}
            onChange={(event) => setColumnSource(event.target.value)}
            value={columnSource}
          >
            <option value={DEFAULT_COLUMNS}>{t('boards.create.defaultColumns')}</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {t('boards.create.copyColumns', { name: board.name })}
              </option>
            ))}
          </Select>
        </FormField>

        <FormError>{error ?? undefined}</FormError>

        <div className="flex justify-end gap-2">
          <button className="admin-button" onClick={close} type="button">
            {t('common.cancel')}
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || createBoard.isPending}
            onClick={submit}
            type="button"
          >
            {t('boards.create.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
