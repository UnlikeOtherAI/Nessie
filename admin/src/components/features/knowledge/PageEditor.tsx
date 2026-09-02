import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  KnowledgePageRecord,
  SavePageInput,
} from '../../../facades/knowledge/hooks'
import { draftKey, useDraft } from '../../../navigation/useDraft'
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
  const [error, setError] = useState<string | null>(null)

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

  // Drafts (docs/navigation.md → "Drafts"): keyed by the page, so navigating
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
    setError(null)
  }, [page, initialTitle])

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
    // Saved: this edit is no longer unsent.
    pageDraft.clear()
  }

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      <div className="grid gap-3 border-b border-[color:var(--sep)] p-4">
        <label className="text-xs text-[color:var(--tx2)]">
          Title
          <input
            className="admin-input mt-1"
            onChange={(event) => patchDraft({ title: event.target.value })}
            value={title}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Summary
          <input
            className="admin-input mt-1"
            onChange={(event) => patchDraft({ summary: event.target.value })}
            value={summary}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Labels
          <input
            className="admin-input mt-1"
            onChange={(event) => patchDraft({ labels: event.target.value })}
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
          onChange={(event) => patchDraft({ changeComment: event.target.value })}
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
