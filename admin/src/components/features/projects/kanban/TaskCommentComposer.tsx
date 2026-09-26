import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { detectSecrets } from '@nessie/schemas'
import { faPaperclip } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Notice } from '../../../primitives/Notice'
import { MarkdownEditor } from '../../../shared/markdown-editor/MarkdownEditor'
import { ComposerAttachments } from '../../channels/ComposerAttachments'
import { useComposerAttachments } from '../../channels/useComposerAttachments'
import { useCreateTaskComment } from '../../../../facades/task-comments/hooks'
import { useTaskImageUpload } from '../../../../facades/task-attachments/hooks'
import { draftKey, useDraft } from '../../../../navigation/useDraft'

type TaskCommentComposerProps = {
  /** Called with the new comment's id once it posted, so the list can bring it into view. */
  onPosted?: (commentId: string) => void
  taskId: string
}

/**
 * The comment box, always last in the dialog: Markdown with images, files
 * staged beside it through the chat composer's own upload path, and Post
 * (or Cmd/Ctrl+Enter). A failed post keeps the text and says why.
 */
export const TaskCommentComposer = ({ onPosted, taskId }: TaskCommentComposerProps) => {
  const { t } = useTranslation('projects')
  // Unsent words survive closing the dialog (docs/navigation/overview.md →
  // "Drafts"), keyed by the ticket; a draft holding a credential is never stored.
  const commentDraft = useDraft<string>(draftKey('task-comment', taskId), {
    initial: '',
    isEmpty: (text) => !text.trim() || detectSecrets(text).length > 0,
  })
  const body = commentDraft.draft
  const setBody = commentDraft.setDraft
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachments = useComposerAttachments()
  const createComment = useCreateTaskComment(taskId)
  const uploadImage = useTaskImageUpload(taskId)

  const canPost = body.trim().length > 0 && !attachments.isUploading && !createComment.isPending

  const post = () => {
    if (!canPost) return
    setError(null)
    createComment.mutate(
      {
        body: body.trim(),
        ...(attachments.attachmentIds.length > 0 ? { attachmentIds: attachments.attachmentIds } : {}),
      },
      {
        onError: (cause) => setError(cause.message || t('comments.postError')),
        onSuccess: (comment) => {
          commentDraft.clear()
          attachments.clearStaged()
          onPosted?.(comment.id)
        },
      },
    )
  }

  return (
    <div className="grid gap-2" data-testid="task-comment-composer">
      <MarkdownEditor
        ariaLabel={t('comments.comment')}
        compact
        disabled={createComment.isPending}
        onChange={setBody}
        onSubmitShortcut={post}
        onUploadImage={uploadImage}
        placeholder={t('comments.writePlaceholder')}
        value={body}
      />
      <ComposerAttachments attachments={attachments} />
      <div className="flex items-center justify-between gap-2">
        <button
          className="admin-button admin-button-secondary admin-button-compact gap-1.5"
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <FontAwesomeIcon icon={faPaperclip} />
          {t('comments.attach')}
        </button>
        <input
          aria-hidden="true"
          className="hidden"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length > 0) attachments.addFiles(files)
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <button
          className="admin-button admin-button-primary admin-button-compact"
          disabled={!canPost}
          onClick={post}
          type="button"
        >
          {t('comments.post')}
        </button>
      </div>
      {error ? (
        <Notice role="alert" size="sm" tone="danger">
          {error}
        </Notice>
      ) : null}
    </div>
  )
}
