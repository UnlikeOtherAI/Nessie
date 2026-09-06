import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import type {
  KnowledgePageRecord,
  SavePageInput,
} from '../../../facades/knowledge/hooks'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { FormError } from '../../shared/FormActions'
import { KnowledgePane } from './KnowledgePane'
import { RichTextEditor } from './RichTextEditor'

// One unsent page edit. Kept whole so leaving the editor loses nothing,
// including where a new page will sit in the hierarchy.
type PageDraft = {
  body: string
  changeComment: string
  labels: string
  parentPageId: string | null
  title: string
}

type PageEditorProps = {
  // Prefills the title in 'create' mode — used when the editor is opened from
  // an unresolved wikilink's "create this page?" confirmation.
  initialTitle?: string
  mode: 'create' | 'edit'
  onBack?: () => void
  onCancel: () => void
  onSubmit: (input: SavePageInput) => Promise<void>
  page?: KnowledgePageRecord | null
  pages: KnowledgePageRecord[]
  parentPageId?: string | null
  pending?: boolean
  spaceName: string
}

type ParentOption = { depth: number; page: KnowledgePageRecord }

const parentOptions = (pages: KnowledgePageRecord[]): ParentOption[] => {
  const documents = pages.filter((page) => page.kind === 'document')
  const children = new Map<string | null, KnowledgePageRecord[]>()
  for (const page of documents) {
    const key = page.parentPageId ?? null
    children.set(key, [...(children.get(key) ?? []), page])
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
  }

  const result: ParentOption[] = []
  const visited = new Set<string>()
  const append = (parentId: string | null, depth: number) => {
    for (const page of children.get(parentId) ?? []) {
      if (visited.has(page.id)) continue
      visited.add(page.id)
      result.push({ depth, page })
      append(page.id, depth + 1)
    }
  }
  append(null, 0)
  // Corrupt or partially loaded ancestry must not make a valid page disappear
  // from the location picker.
  for (const page of documents) {
    if (!visited.has(page.id)) result.push({ depth: 0, page })
  }
  return result
}

const splitLabels = (raw: string): string[] =>
  raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)

export const PageEditor = ({
  initialTitle,
  mode,
  onBack,
  onCancel,
  onSubmit,
  page,
  pages,
  parentPageId,
  pending,
  spaceName,
}: PageEditorProps) => {
  const formId = useId()
  const titleErrorId = `${formId}-title-error`
  const [titleError, setTitleError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | undefined>()

  // The page as stored — the draft's baseline, so opening a page and leaving
  // it untouched stores nothing. Summary is deliberately not an authoring
  // field: existing summaries remain API/search metadata, not page furniture.
  const baseline = useMemo<PageDraft>(
    () => ({
      body: page?.latestVersion?.body ?? '',
      changeComment: '',
      labels: page?.labels.join(', ') ?? '',
      parentPageId: mode === 'create' ? parentPageId ?? null : page?.parentPageId ?? null,
      title: page?.title ?? initialTitle ?? '',
    }),
    [initialTitle, mode, page, parentPageId],
  )

  // Drafts (docs/navigation/overview.md → "Drafts"): keyed by the page, so navigating
  // away mid-rewrite keeps the words. Local only — every server save appends a
  // `KnowledgePageVersion`, so a debounced flush would turn one edit into
  // dozens of versions and bury the history the version panel exists for.
  // "Save version" therefore stays the deliberate act.
  const pageDraft = useDraft<PageDraft>(draftKey('kb-page', page?.id ?? 'new'), {
    initial: baseline,
  })
  const { body, changeComment, labels, parentPageId: draftParentPageId, title } = pageDraft.draft
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
      setTitleError('Give this page a title.')
      return
    }
    setTitleError(undefined)
    setFormError(undefined)
    try {
      await onSubmit({
        title: title.trim(),
        labels: splitLabels(labels),
        body,
        changeComment: changeComment.trim() || null,
        parentPageId: mode === 'create' ? draftParentPageId : undefined,
      })
      pageDraft.clear()
    } catch (error) {
      setFormError(toFormErrors(error).formError ?? 'Unable to save this page.')
    }
  }

  const actions: PageHeaderAction[] = [
    {
      id: 'cancel-page-edit',
      label: 'Cancel',
      onSelect: onCancel,
      priority: 50,
    },
    {
      disabled: pending,
      form: formId,
      id: 'save-page',
      label: pending
        ? 'Saving…'
        : mode === 'create'
          ? 'Create page'
          : 'Save version',
      onSelect: () => undefined,
      primary: true,
      priority: 100,
      submit: true,
    },
  ]

  return (
    <form className="h-full" id={formId} onSubmit={submit}>
      <KnowledgePane
        actions={actions}
        onBack={onBack}
        title={mode === 'create' ? 'New page' : 'Edit page'}
      >
        <div className="h-full overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-10 sm:px-10 sm:py-14 lg:px-16">
            {mode === 'create' ? (
              <div className="mb-8 flex items-center gap-2 text-sm text-[color:var(--tx3)]">
                <span>Location</span>
                <span aria-hidden="true">/</span>
                <select
                  aria-label="Parent page"
                  className="min-w-0 max-w-full bg-transparent font-medium text-[color:var(--tx2)] outline-none focus:text-[color:var(--tx)]"
                  onChange={(event) => patchDraft({ parentPageId: event.target.value || null })}
                  value={draftParentPageId ?? ''}
                >
                  <option value="">{spaceName}</option>
                  {parentOptions(pages).map(({ depth, page: parent }) => (
                    <option key={parent.id} value={parent.id}>
                      {`${'  '.repeat(depth + 1)}${parent.title}`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <input
              aria-describedby={titleError ? titleErrorId : undefined}
              aria-invalid={Boolean(titleError) || undefined}
              aria-label="Page title"
              autoFocus
              className="w-full border-none bg-transparent text-[3.8025rem] font-bold leading-tight text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)] sm:text-[5.07rem]"
              onChange={(event) => patchDraft({ title: event.target.value })}
              placeholder="Give this page a title…"
              value={title}
            />
            {titleError ? (
              <p className="mt-2 text-sm text-[color:var(--danger-text)]" id={titleErrorId} role="alert">
                {titleError}
              </p>
            ) : null}

            <div className="mt-8 flex min-h-[28rem] flex-1 flex-col">
              <RichTextEditor
                onChange={setBody}
                placeholder="Start writing…"
                value={body}
              />
            </div>

            <div className="mt-10 grid gap-2 border-t border-[color:var(--sep)] py-5">
              <input
                aria-label="Labels"
                className="w-full border-none bg-transparent py-2 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
                onChange={(event) => patchDraft({ labels: event.target.value })}
                placeholder="Add labels, separated by commas"
                value={labels}
              />
              <input
                aria-label="Change comment"
                className="w-full border-none bg-transparent py-2 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
                onChange={(event) => patchDraft({ changeComment: event.target.value })}
                placeholder="Add a change comment (optional)"
                value={changeComment}
              />
            </div>
            <FormError className="mb-8">{formError}</FormError>
          </div>
        </div>
      </KnowledgePane>
    </form>
  )
}
