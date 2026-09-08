import { useEffect, useRef, useState } from 'react'
import { useAuthedTextFromPath } from '../../../lib/uploads'
import { Dialog } from '../../shared/Dialog'

const MARKDOWN_EDITOR_MAX_BYTES = 5 * 1024 * 1024

type MarkdownFileEditorDialogProps = {
  baseVersionId: string
  downloadPath: string
  filename: string
  onClose: () => void
  onSave: (markdown: string, baseVersionId: string) => Promise<void>
  token: string | null
}

// Markdown files retain their attachment as canonical storage. This dialog
// edits a downloaded copy and saves it through the ordinary file-version
// upload route, which reads the stored bytes back before deriving the body.
export const MarkdownFileEditorDialog = ({
  baseVersionId,
  downloadPath,
  filename,
  onClose,
  onSave,
  token,
}: MarkdownFileEditorDialogProps) => {
  const source = useAuthedTextFromPath(downloadPath, token, MARKDOWN_EDITOR_MAX_BYTES)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (source.text !== null && !source.truncated) {
      setDraft(source.text)
      setSaveError(null)
    }
  }, [source.text, source.truncated])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(draft, baseVersionId)
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Markdown could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      description={filename}
      dismissDisabled={saving}
      initialFocusRef={editorRef}
      onClose={onClose}
      open
      size="xl"
      title="Edit Markdown"
    >
      {source.loading ? (
        <p className="py-8 text-sm text-[color:var(--tx3)]">Loading Markdown…</p>
      ) : source.error ? (
        <p className="py-8 text-sm text-[color:var(--danger-text)]">Markdown could not be loaded.</p>
      ) : source.truncated ? (
        <p className="py-8 text-sm text-[color:var(--tx3)]">
          This file is too large to edit here. Download it, then upload a new version.
        </p>
      ) : (
        <>
          <textarea
            aria-label="Markdown source"
            className="admin-input min-h-[52vh] w-full resize-y font-mono text-sm leading-relaxed"
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            ref={editorRef}
            spellCheck={false}
            value={draft}
          />
          {saveError ? <p className="mt-3 text-xs text-[color:var(--danger-text)]">{saveError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button className="admin-button admin-button-secondary" disabled={saving} onClick={onClose} type="button">
              Cancel
            </button>
            <button className="admin-button admin-button-primary" disabled={saving || source.text === null} onClick={() => void save()} type="button">
              {saving ? 'Saving…' : 'Save new version'}
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
