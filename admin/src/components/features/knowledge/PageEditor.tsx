import { useEffect, useState, type FormEvent } from 'react'
import type {
  KnowledgePageRecord,
  SavePageInput,
} from '../../../facades/knowledge/hooks'
import { RichTextEditor } from './RichTextEditor'

type PageEditorProps = {
  mode: 'create' | 'edit'
  onCancel: () => void
  onSubmit: (input: SavePageInput) => Promise<void>
  page?: KnowledgePageRecord | null
  parentPageId?: string | null
  pending?: boolean
}

const splitLabels = (raw: string): string[] =>
  raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)

export const PageEditor = ({
  mode,
  onCancel,
  onSubmit,
  page,
  parentPageId,
  pending,
}: PageEditorProps) => {
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [labels, setLabels] = useState('')
  const [body, setBody] = useState('')
  const [changeComment, setChangeComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitle(page?.title ?? '')
    setSummary(page?.summary ?? '')
    setLabels(page?.labels.join(', ') ?? '')
    setBody(page?.latestVersion?.body ?? '')
    setChangeComment('')
    setError(null)
  }, [page])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    setError(null)
    await onSubmit({
      title: title.trim(),
      summary: summary.trim() || null,
      labels: splitLabels(labels),
      body,
      changeComment: changeComment.trim() || null,
      parentPageId: mode === 'create' ? parentPageId ?? null : undefined,
    })
  }

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      <div className="grid gap-3 border-b border-[color:var(--sep)] p-4">
        <label className="text-xs text-[color:var(--tx2)]">
          Title
          <input
            className="admin-input mt-1"
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Summary
          <input
            className="admin-input mt-1"
            onChange={(event) => setSummary(event.target.value)}
            value={summary}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Labels
          <input
            className="admin-input mt-1"
            onChange={(event) => setLabels(event.target.value)}
            placeholder="runbook, onboarding"
            value={labels}
          />
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <span className="mb-1 text-xs text-[color:var(--tx2)]">Body</span>
        <RichTextEditor
          onChange={setBody}
          placeholder="Write the page…"
          value={body}
        />
      </div>

      <div className="grid gap-3 border-t border-[color:var(--sep)] p-4">
        <input
          className="admin-input"
          onChange={(event) => setChangeComment(event.target.value)}
          placeholder="Change comment"
          value={changeComment}
        />
        {error ? <div className="text-sm text-[var(--danger-text)]">{error}</div> : null}
        <div className="flex items-center gap-2">
          <button
            className="admin-button admin-button-primary"
            disabled={pending}
            type="submit"
          >
            {mode === 'create' ? 'Create page' : 'Save version'}
          </button>
          <button
            className="admin-button admin-button-secondary"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
