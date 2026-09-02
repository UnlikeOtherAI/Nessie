import { useEffect, useState, type FormEvent } from 'react'
import type {
  KnowledgePageRecord,
  SavePageInput,
} from '../../../facades/knowledge/hooks'
import { toFormErrors } from '../../../facades/form-errors'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { RichTextEditor } from './RichTextEditor'

type PageEditorProps = {
  // Prefills the title in 'create' mode — used when the editor is opened from
  // an unresolved wikilink's "create this page?" confirmation.
  initialTitle?: string
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
  initialTitle,
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
  const [titleError, setTitleError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | undefined>()

  useEffect(() => {
    setTitle(page?.title ?? initialTitle ?? '')
    setSummary(page?.summary ?? '')
    setLabels(page?.labels.join(', ') ?? '')
    setBody(page?.latestVersion?.body ?? '')
    setChangeComment('')
    setTitleError(undefined)
    setFormError(undefined)
  }, [page, initialTitle])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) {
      setTitleError('Title is required.')
      return
    }
    setTitleError(undefined)
    setFormError(undefined)
    try {
      await onSubmit({
        title: title.trim(),
        summary: summary.trim() || null,
        labels: splitLabels(labels),
        body,
        changeComment: changeComment.trim() || null,
        parentPageId: mode === 'create' ? parentPageId ?? null : undefined,
      })
    } catch (error) {
      setFormError(toFormErrors(error).formError ?? 'Unable to save this page.')
    }
  }

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      <div className="grid gap-3 border-b border-[color:var(--sep)] p-4">
        <FormField error={titleError} label="Title" required>
          <Input onChange={(event) => setTitle(event.target.value)} value={title} />
        </FormField>
        <FormField label="Summary">
          <Input onChange={(event) => setSummary(event.target.value)} value={summary} />
        </FormField>
        <FormField help="Comma-separated" label="Labels">
          <Input
            onChange={(event) => setLabels(event.target.value)}
            placeholder="runbook, onboarding"
            value={labels}
          />
        </FormField>
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
        <Input
          onChange={(event) => setChangeComment(event.target.value)}
          placeholder="Change comment"
          value={changeComment}
        />
        <FormError>{formError}</FormError>
        <FormActions>
          <button
            className="admin-button admin-button-secondary"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={pending}
            type="submit"
          >
            {mode === 'create' ? 'Create page' : 'Save version'}
          </button>
        </FormActions>
      </div>
    </form>
  )
}
