import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { DOCUMENT_TRIGGER_QUIET_SECONDS } from '@nessie/schemas'

import { useKnowledgePages, useKnowledgeSpaces } from '../../../facades/knowledge/hooks'
import { Checkbox } from '../../primitives/Checkbox'
import { LabelPill } from '../../primitives/LabelPill'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { TokenInput } from '../../shared/TokenInput'
import { useDisplayedKnowledgeSpace } from '../knowledge/KnowledgeProvider'
import {
  DOCUMENT_INSTRUCTIONS_EXAMPLE,
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_TRIGGER_MAX_LABELS,
  DOCUMENT_TRIGGER_MAX_PAGES,
  documentPickerOptions,
  getDefaultDocumentState,
  isProjectDocumentsSpace,
  spaceNarrowerThanChannel,
  type DocumentFieldErrors,
  type DocumentTriggerFormState,
} from './document-trigger-form'
import { formatQuietWindow } from './document-trigger-presentation'
import { fieldLabelClass, type TriggerFormState } from './trigger-config'
import { TriggerFieldError, TriggerFieldSection } from './TriggerFieldParts'

/**
 * The `document_changed` fields of the Triggers editor
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "`document_changed`").
 * The space, its folder and its pages are picked, never typed — the space from
 * the chosen channel's project, each folder and page by its path — and a
 * server refusal lands on the field it names. It says what never wakes the
 * agent (its own saves; a spreadsheet's), because a person looking at a quiet
 * trigger otherwise has no way to learn why.
 */

type DocumentTriggerFieldsProps = {
  errors: DocumentFieldErrors
  form: TriggerFormState
  /** The project of the chosen channel: the only project whose spaces this trigger may watch. */
  projectId: string | null
  setForm: Dispatch<SetStateAction<TriggerFormState>>
}

const FIRE_ON_HINT = {
  save: 'Every saved version wakes it. A save here is deliberate: documents are not co-edited live.',
  publish: 'Only a newly published version wakes it; saving a draft does not.',
} as const

export const DocumentTriggerFields = ({ errors, form, projectId, setForm }: DocumentTriggerFieldsProps) => {
  const state = form.document ?? getDefaultDocumentState()
  const spacesQuery = useKnowledgeSpaces(projectId ?? undefined, Boolean(projectId))
  const spaces = spacesQuery.items
  const chosen = useDisplayedKnowledgeSpace(spaces, state.spaceId || undefined)
  const { data: pages = [] } = useKnowledgePages(state.spaceId || undefined)
  const options = useMemo(() => documentPickerOptions(pages, state), [pages, state])

  const patch = (next: Partial<DocumentTriggerFormState>) =>
    setForm((current) => ({ ...current, document: { ...(current.document ?? getDefaultDocumentState()), ...next } }))

  // No space yet, or one of another project (the channel moved): the project's
  // own Documents space. A space this list does not show but the person can
  // still read — a later page of it — is kept; one they cannot read is left
  // for the server to name.
  const listed = spacesQuery.query.isSuccess
  const foreign = Boolean(state.spaceId) && chosen !== null && chosen.projectId !== projectId
  useEffect(() => {
    if (!listed || (state.spaceId && !foreign)) return
    const fallback = spaces.find(isProjectDocumentsSpace)
      ?? spaces.find((space) => !spaceNarrowerThanChannel(space))
      ?? spaces[0]
    const next = fallback?.id ?? ''
    if (next === state.spaceId) return
    setForm((current) => ({
      ...current,
      document: { ...(current.document ?? getDefaultDocumentState()), folderPageId: '', pageIds: [], spaceId: next },
    }))
  }, [foreign, listed, setForm, spaces, state.spaceId])

  const spaceOptions = chosen && !foreign && !spaces.some((space) => space.id === chosen.id)
    ? [...spaces, chosen]
    : spaces
  const pageLabel = new Map(options.pages.map((page) => [page.id, page.label]))
  const knownPageIds = new Set(pages.map((page) => page.id))
  // A page outside what is now watched never fires, so it leaves the list;
  // one this list cannot show is left for the server to name.
  const keepPages = (next: Pick<DocumentTriggerFormState, 'folderPageId' | 'kinds'>) => {
    const still = new Set(documentPickerOptions(pages, { ...state, ...next }).pages.map((page) => page.id))
    return state.pageIds.filter((id) => still.has(id) || !knownPageIds.has(id))
  }
  const quiet = Number(state.quietSeconds)

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="grid content-start gap-1.5">
        <label className={fieldLabelClass} htmlFor="document-trigger-space">Space</label>
        <select
          className="admin-input"
          id="document-trigger-space"
          onChange={(event) => patch({ folderPageId: '', pageIds: [], spaceId: event.target.value })}
          value={state.spaceId}
        >
          {spaceOptions.length === 0 ? <option value="">This channel’s project has no document space yet</option> : null}
          {spaceOptions.map((space) => {
            const narrower = spaceNarrowerThanChannel(space)
            return (
              <option disabled={Boolean(narrower) && space.id !== state.spaceId} key={space.id} value={space.id}>
                {narrower ? `${space.name} — ${narrower}` : space.name}
              </option>
            )
          })}
        </select>
        <p className="text-xs text-[color:var(--tx3)]">
          Every reader of the channel must be able to read it, so only a project- or organisation-wide space can
          be watched.
        </p>
        <TriggerFieldError field="spaceId" message={errors.spaceId} />
      </div>

      <div className="grid content-start gap-1.5">
        <label className={fieldLabelClass} htmlFor="document-trigger-folder">Folder</label>
        <select
          className="admin-input"
          id="document-trigger-folder"
          onChange={(event) => patch({
            folderPageId: event.target.value,
            pageIds: keepPages({ folderPageId: event.target.value, kinds: state.kinds }),
          })}
          value={state.folderPageId}
        >
          <option value="">The whole space</option>
          {options.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
        </select>
        <p className="text-xs text-[color:var(--tx3)]">Only pages inside this folder, at any depth.</p>
        <TriggerFieldError field="folderPageId" message={errors.folderPageId} />
      </div>

      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="document-trigger-pages">
          Pages <span className="normal-case tracking-normal opacity-70">(optional)</span>
        </label>
        <TokenInput
          ariaLabel="Pages"
          id="document-trigger-pages"
          onAdd={(id) => patch({ pageIds: [...new Set([...state.pageIds, id])].slice(0, DOCUMENT_TRIGGER_MAX_PAGES) })}
          onRemove={(id) => patch({ pageIds: state.pageIds.filter((entry) => entry !== id) })}
          options={options.pages}
          placeholder={state.folderPageId ? 'Every page in the folder' : 'Every page in the space'}
          tokens={state.pageIds.map((id) => ({ id, label: pageLabel.get(id) ?? 'A page not listed here' }))}
        />
        <p className="text-xs text-[color:var(--tx3)]">
          Leave empty to watch every page. Up to {DOCUMENT_TRIGGER_MAX_PAGES}; for more, watch their folder.
        </p>
        <TriggerFieldError field="pageIds" message={errors.pageIds} />
      </div>

      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="document-trigger-labels">
          Labels <span className="normal-case tracking-normal opacity-70">(optional)</span>
        </label>
        <TokenInput
          ariaLabel="Labels"
          createLabel={(text) => `Watch the label “${text}”`}
          id="document-trigger-labels"
          onAdd={(label) => patch({
            labels: [...new Set([...state.labels, label])].slice(0, DOCUMENT_TRIGGER_MAX_LABELS),
          })}
          onCreate={async (text) => ({ id: text.trim() })}
          onRemove={(label) => patch({ labels: state.labels.filter((entry) => entry !== label) })}
          options={options.labels.map((label) => ({ id: label, label }))}
          placeholder="Any label"
          renderToken={(token, remove) => <LabelPill color="" name={token.label} onRemove={remove} size="sm" />}
          tokens={state.labels.map((label) => ({ id: label, label }))}
        />
        <p className="text-xs text-[color:var(--tx3)]">Only pages carrying at least one of these labels.</p>
        <TriggerFieldError field="labels" message={errors.labels} />
      </div>

      <TriggerFieldSection
        hint="A spreadsheet never wakes it: its saves are live cell edits."
        title="Wake the agent on"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {DOCUMENT_KIND_OPTIONS.map(({ description, kind, label }) => (
            <Checkbox
              checked={state.kinds.includes(kind)}
              description={description}
              key={kind}
              label={label}
              onChange={(on) => {
                const kinds = on ? [...new Set([...state.kinds, kind])] : state.kinds.filter((entry) => entry !== kind)
                patch({ kinds, pageIds: keepPages({ folderPageId: state.folderPageId, kinds }) })
              }}
            />
          ))}
        </div>
        <TriggerFieldError field="kinds" message={errors.kinds} />
        <ChoiceGroup
          label="Wake it on"
          labelHidden
          onChange={(fireOn) => patch({ fireOn })}
          options={[{ label: 'Every save', value: 'save' }, { label: 'A publish', value: 'publish' }]}
          value={state.fireOn}
          variant="inline"
        />
        <p className="text-xs text-[color:var(--tx3)]">{FIRE_ON_HINT[state.fireOn]}</p>
        <TriggerFieldError field="fireOn" message={errors.fireOn} />
        <Checkbox
          checked={state.includeAgentEdits}
          description="Its own saves never wake it, so it cannot loop on its own edits."
          label="Also wake on another agent’s saves"
          onChange={(includeAgentEdits) => patch({ includeAgentEdits })}
        />
        <TriggerFieldError field="includeAgentEdits" message={errors.includeAgentEdits} />
      </TriggerFieldSection>

      <div className="grid content-start gap-1.5">
        <label className={fieldLabelClass} htmlFor="document-trigger-quiet">Quiet window (seconds)</label>
        <input
          className="admin-input"
          id="document-trigger-quiet"
          inputMode="numeric"
          max={DOCUMENT_TRIGGER_QUIET_SECONDS.max}
          min={DOCUMENT_TRIGGER_QUIET_SECONDS.min}
          onChange={(event) => patch({ quietSeconds: event.target.value })}
          type="number"
          value={state.quietSeconds}
        />
        <p className="text-xs text-[color:var(--tx3)]">
          {Number.isInteger(quiet) && quiet > 0 ? `${formatQuietWindow(quiet)} after the first save. ` : ''}
          Every save inside it wakes the agent once, with the whole change.
        </p>
        <TriggerFieldError field="quietSeconds" message={errors.quietSeconds} />
      </div>

      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="document-trigger-instructions">Instructions</label>
        <textarea
          className="admin-input min-h-20"
          id="document-trigger-instructions"
          onChange={(event) => patch({ instructions: event.target.value })}
          placeholder={DOCUMENT_INSTRUCTIONS_EXAMPLE}
          value={state.instructions}
        />
        <p className="text-xs text-[color:var(--tx3)]">
          What the agent does when a watched document changes. Every wake shows it; the agent reads the change
          itself, and nothing of the document is in the wake.
        </p>
        <TriggerFieldError field="instructions" message={errors.instructions} />
      </div>
    </div>
  )
}
