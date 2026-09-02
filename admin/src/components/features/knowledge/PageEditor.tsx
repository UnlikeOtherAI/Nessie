import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  KnowledgePageRecord,
  SavePageInput,
} from '../../../facades/knowledge/hooks'
import { toFormErrors } from '../../../facades/form-errors'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { RichTextEditor } from './RichTextEditor'

// One unsent page edit. Kept whole so a dismissed editor loses nothing.
type PageDraft = {
  body: string
  changeComment: string
  labels: string
  summary: string
  title: string
}

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
  // Two separate complaints: the one the Title field owns, and the one the
  // save itself returned. A server error rendered above the form is not a
  // field error, and a field error shown once at the top is unreachable.
  const [titleError, setTitleError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | undefined>()

  // The page as stored — the draft's baseline, so opening a page and leaving
  // it untouched stores nothing.
  const baseline = useMemo<PageDraft>(
    () => ({
      body: page?.latestVersion?.body ?? '',
      changeComment: '',
      labels: page?.labels.join(', ') ?? '',
      summary: page?.summary ?? '',
      title: page?.title ?? initialTitle ?? '',
    }),
    [initialTitle, page],
  )

  // Drafts (docs/navigation/overview.md → "Drafts"): keyed by the page, so navigating
  // away mid-rewrite keeps the words. Local only — every server save appends a
  // `KnowledgePageVersion`, so a debounced flush would turn one edit into
  // dozens of versions and bury the history the version panel exists for.
  // "Save version" therefore stays the deliberate act.
  const pageDraft = useDraft<PageDraft>(draftKey('kb-page', page?.id ?? 'new'), {
    initial: baseline,
  })
  const { body, changeComment, labels, summary, title } = pageDraft.draft
  const setDraft = pageDraft.setDraft
  const patchDraft = useCallback(
    (patch: Partial<PageDraft>) => setDraft((current) => ({ ...current, ...patch })),
    [setDraft],
  )
  const setBody = useCallback((next: string) => patchDraft({ body: next }), [patchDraft])

  useEffect(() => {
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
      // Saved: this edit is no longer unsent.
      pageDraft.clear()
    } catch (error) {
      setFormError(toFormErrors(error).formError ?? 'Unable to save this page.')
    }
  }

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      <div className="grid gap-3 border-b border-[color:var(--sep)] p-4">
        <FormField error={titleError} label="Title" required>
          <Input onChange={(event) => patchDraft({ title: event.target.value })} value={title} />
        </FormField>
        <FormField label="Summary">
          <Input
            onChange={(event) => patchDraft({ summary: event.target.value })}
            value={summary}
          />
        </FormField>
        <FormField help="Comma-separated" label="Labels">
          <Input
            onChange={(event) => patchDraft({ labels: event.target.value })}
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
          onChange={(event) => patchDraft({ changeComment: event.target.value })}
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
