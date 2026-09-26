import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { faPen } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { MarkdownEditor } from '../../../shared/markdown-editor/MarkdownEditor'
import { MessageMarkdown } from '../../channels/MessageMarkdown'
import { useTaskImageUpload } from '../../../../facades/task-attachments/hooks'
import type { UploadProgress } from '../../../../lib/upload-xhr'

type TaskDescriptionFieldProps = {
  /** False for a viewer who may read the ticket but not change it: no pencil. */
  canEdit: boolean
  /** Create mode: the editor is open from the start and there is no toggle. */
  createMode: boolean
  onChange: (markdown: string) => void
  /**
   * Create mode only — an image uploaded before the ticket exists rides the
   * create call's `attachmentIds`, so the dialog keeps its id.
   */
  onPendingAttachment?: (attachmentId: string) => void
  /** Edit mode: an image is linked to this ticket the moment its bytes land. */
  taskId?: string
  value: string
}

const readViewClass = [
  'min-h-[3rem] cursor-text rounded-md px-2 py-1.5 -mx-2',
  'hover:bg-[color:var(--overlay-weak)] focus-visible:outline-2',
  'focus-visible:outline-[color:var(--accent)]',
].join(' ')

/**
 * The ticket's description: rendered Markdown to read, and the rich-text
 * editor behind a pencil to change it (ui.md §5.3).
 *
 * The toggle is a view switch, not a save: *Done* goes back to the rendered
 * draft and nothing reaches the server until *Save changes*, like every other
 * field in the dialog. Images are the exception by design — they upload as
 * they are dropped, because a file is not a keystroke — and in edit mode land
 * on the ticket straight away, so closing unsaved never strands one.
 */
export const TaskDescriptionField = ({
  canEdit,
  createMode,
  onChange,
  onPendingAttachment,
  taskId,
  value,
}: TaskDescriptionFieldProps) => {
  const { t } = useTranslation('projects')
  const [editing, setEditing] = useState(createMode)
  const uploadToTicket = useTaskImageUpload(createMode ? undefined : taskId)
  const uploadImage = useCallback(
    async (file: File, onProgress?: (progress: UploadProgress) => void) => {
      const uploaded = await uploadToTicket(file, onProgress)
      if (createMode) onPendingAttachment?.(uploaded.id)
      return uploaded
    },
    [createMode, onPendingAttachment, uploadToTicket],
  )

  const open = editing && canEdit
  const startEditing = () => {
    if (canEdit) setEditing(true)
  }

  return (
    <div className="grid gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <SectionLabel as="span" size="sm">{t('taskDescription.title')}</SectionLabel>
        {createMode || !canEdit ? null : open ? (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => setEditing(false)}
            type="button"
          >
            {t('taskDescription.done')}
          </button>
        ) : (
          <button
            aria-label={t('taskDescription.edit')}
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
            onClick={startEditing}
            title={t('taskDescription.edit')}
            type="button"
          >
            <FontAwesomeIcon icon={faPen} />
          </button>
        )}
      </div>

      {open ? (
        <MarkdownEditor
          ariaLabel={t('taskDescription.title')}
          autoFocus={!createMode}
          onChange={onChange}
          onUploadImage={uploadImage}
          placeholder={t('taskDescription.placeholder')}
          value={value}
        />
      ) : (
        <div
          aria-label={canEdit ? t('taskDescription.selectToEdit') : t('taskDescription.title')}
          className={canEdit ? readViewClass : undefined}
          data-testid="task-description-read"
          onClick={(event) => {
            // A link in the text is followed, not turned into an edit.
            if ((event.target as HTMLElement).closest('a')) return
            startEditing()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.target !== event.currentTarget) return
            event.preventDefault()
            startEditing()
          }}
          role={canEdit ? 'button' : undefined}
          tabIndex={canEdit ? 0 : undefined}
        >
          {value.trim() ? (
            <MessageMarkdown renderInlineText={(text) => text} resolveAttachmentImages>
              {value}
            </MessageMarkdown>
          ) : (
            <p className="text-sm text-[color:var(--tx3)]">{t('taskDescription.empty')}</p>
          )}
        </div>
      )}
    </div>
  )
}
