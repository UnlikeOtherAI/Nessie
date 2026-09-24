import {
  DOCUMENT_TRIGGER_QUIET_SECONDS,
  DocumentChangedStoredConfigSchema,
  type DocumentTriggerFireOn,
  type DocumentTriggerKind,
} from '@nessie/schemas'

import type { KnowledgePageRecord, KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import { groupTriggerRefusals, refusalFieldIn, type TriggerFieldErrors } from './trigger-refusals'

/**
 * The `document_changed` half of the Triggers editor as form state, and the
 * typed config it posts (`DocumentChangedTriggerConfigSchema`,
 * docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "`document_changed`").
 * The editor picks the space, folder and pages, so it names them by id; the
 * server resolves and checks every field again — the space readable by the
 * whole channel, the agent and the person setting it up — and refuses field
 * by field, and those refusals land on the field they name.
 */

export type DocumentTriggerFormState = {
  /** Empty: the channel's project's Documents space, resolved on the server. */
  spaceId: string
  /** Empty: the whole space. */
  folderPageId: string
  pageIds: string[]
  labels: string[]
  kinds: DocumentTriggerKind[]
  fireOn: DocumentTriggerFireOn
  quietSeconds: string
  includeAgentEdits: boolean
  instructions: string
}

/** What a doorway already knows: the Finder opens the editor on a folder, or on one page. */
export type DocumentTriggerPrefill = {
  folderPageId?: string
  pageIds?: string[]
  spaceId: string
}

/** The server accepts at most this many pages and labels (`DocumentChangedTriggerConfigSchema`). */
export const DOCUMENT_TRIGGER_MAX_PAGES = 50
export const DOCUMENT_TRIGGER_MAX_LABELS = 20

export const DOCUMENT_KIND_OPTIONS: readonly { kind: DocumentTriggerKind; label: string; description: string }[] = [
  { kind: 'document', label: 'Documents', description: 'Rich-text pages written in Nessie' },
  { kind: 'file', label: 'Files', description: 'Markdown and other uploaded files' },
]

/** A neutral example: how an instruction reads, not what this agent should do. */
export const DOCUMENT_INSTRUCTIONS_EXAMPLE =
  'Read what changed with kb_page_diff. If it changes what the team agreed, say how in the document’s '
  + 'thread and suggest what to update.'

export const DOCUMENT_TARGET_CHANNEL_HINT =
  'Only public project channels are listed: the agent reviews each change in a thread here, so everyone '
  + 'who can read the channel has to be able to read the documents it watches.'

type SpaceAudience = Pick<KnowledgeSpaceRecord, 'ownerAgentId' | 'privateToAgentId' | 'sensitivityTier' | 'visibility'>

/**
 * Why a space cannot be watched from a public project channel, or null: the
 * server's audience rule (`documentSpaceAudienceRefusal`) as far as a space
 * record shows it. Every reader of the channel must be able to read what is
 * reviewed there, so only a project- or organisation-wide space qualifies.
 * The server still asks whether the agent and the person can read it.
 */
export const spaceNarrowerThanChannel = (space: SpaceAudience): string | null => {
  if (space.sensitivityTier === 'restricted') return 'holds restricted documents'
  if (space.ownerAgentId || space.privateToAgentId) return 'is an agent’s own space'
  if (space.visibility !== 'project' && space.visibility !== 'organization') {
    return `is readable by its ${space.visibility === 'private' ? 'owner' : space.visibility} only`
  }
  return null
}

/** The project's own Documents space: where a trigger that names no space watches. */
export const isProjectDocumentsSpace = (space: Pick<KnowledgeSpaceRecord, 'metadata'>): boolean =>
  space.metadata?.projectDocuments === true

export const getDefaultDocumentState = (prefill?: DocumentTriggerPrefill): DocumentTriggerFormState => ({
  spaceId: prefill?.spaceId ?? '',
  folderPageId: prefill?.folderPageId ?? '',
  pageIds: prefill?.pageIds ?? [],
  labels: [],
  kinds: ['document', 'file'],
  fireOn: 'save',
  quietSeconds: String(DOCUMENT_TRIGGER_QUIET_SECONDS.default),
  includeAgentEdits: false,
  instructions: '',
})

/** The stored, resolved config read back into the form. */
export const documentStateFromConfig = (config: unknown): DocumentTriggerFormState => {
  const parsed = DocumentChangedStoredConfigSchema.safeParse(config)
  if (!parsed.success) return getDefaultDocumentState()
  const stored = parsed.data
  return {
    spaceId: stored.spaceId,
    folderPageId: stored.folderPageId ?? '',
    pageIds: stored.pageIds ?? [],
    labels: stored.labels ?? [],
    kinds: [...stored.kinds],
    fireOn: stored.fireOn,
    quietSeconds: String(stored.quietSeconds),
    includeAgentEdits: stored.includeAgentEdits,
    instructions: stored.instructions?.general ?? '',
  }
}

/** The editor's fields a server refusal can land on. */
export type DocumentFormField =
  | 'targetChannelId'
  | 'spaceId'
  | 'folderPageId'
  | 'pageIds'
  | 'labels'
  | 'kinds'
  | 'fireOn'
  | 'quietSeconds'
  | 'includeAgentEdits'
  | 'instructions'

const FIELD_ROOTS: readonly DocumentFormField[] = [
  'targetChannelId', 'spaceId', 'folderPageId', 'pageIds', 'labels', 'kinds', 'fireOn', 'quietSeconds',
  'includeAgentEdits', 'instructions',
]

/** `pageIds[2]` → `pageIds`; `instructions.general` → `instructions`. */
export const documentRefusalField = (path: string): DocumentFormField | null => refusalFieldIn(FIELD_ROOTS, path)

export type DocumentFieldErrors = TriggerFieldErrors<DocumentFormField>

export const groupDocumentRefusals = (details: unknown): { fields: DocumentFieldErrors; rest: string[] } =>
  groupTriggerRefusals(details, documentRefusalField)

export type DocumentConfigResult =
  | { config: Record<string, unknown> }
  | { error: string; field: DocumentFormField }

const readQuietSeconds = (value: string): number | null => {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed)
    && parsed >= DOCUMENT_TRIGGER_QUIET_SECONDS.min
    && parsed <= DOCUMENT_TRIGGER_QUIET_SECONDS.max
    ? parsed
    : null
}

/**
 * The typed `document_changed` config the create and update routes accept.
 *
 * A create leaves out a narrowing nobody set, so the server's defaults apply.
 * An edit sends `null` for one, because the update route merges the config it
 * is given over the stored one and only `null` clears a key the stored config
 * still holds.
 */
export const buildDocumentConfig = (
  state: DocumentTriggerFormState,
  mode: 'create' | 'edit' = 'create',
): DocumentConfigResult => {
  if (state.kinds.length === 0) {
    return { error: 'Pick what wakes the agent: documents, files or both.', field: 'kinds' }
  }
  if (state.pageIds.length > DOCUMENT_TRIGGER_MAX_PAGES) {
    return { error: `Pick at most ${DOCUMENT_TRIGGER_MAX_PAGES} pages, or watch their folder.`, field: 'pageIds' }
  }
  const labels = [...new Map(state.labels
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => [label.toLowerCase(), label] as const)).values()]
  if (labels.length > DOCUMENT_TRIGGER_MAX_LABELS) {
    return { error: `Pick at most ${DOCUMENT_TRIGGER_MAX_LABELS} labels.`, field: 'labels' }
  }
  const quietSeconds = readQuietSeconds(state.quietSeconds)
  if (quietSeconds === null) {
    return {
      error: `The quiet window is a whole number of seconds from ${DOCUMENT_TRIGGER_QUIET_SECONDS.min} `
        + `to ${DOCUMENT_TRIGGER_QUIET_SECONDS.max}.`,
      field: 'quietSeconds',
    }
  }
  const general = state.instructions.trim()
  if (!general) {
    return { error: 'Say what the agent does with an edited document; every wake shows it.', field: 'instructions' }
  }
  const narrowing = (key: 'folderPageId' | 'labels' | 'pageIds', value: unknown) =>
    value !== null ? { [key]: value } : mode === 'edit' ? { [key]: null } : {}
  return {
    config: {
      ...(state.spaceId ? { spaceId: state.spaceId } : {}),
      ...narrowing('folderPageId', state.folderPageId || null),
      ...narrowing('pageIds', state.pageIds.length > 0 ? state.pageIds : null),
      ...narrowing('labels', labels.length > 0 ? labels : null),
      kinds: state.kinds,
      fireOn: state.fireOn,
      quietSeconds,
      includeAgentEdits: state.includeAgentEdits,
      instructions: { general },
    },
  }
}

// ─── The space's pages, as the pickers offer them ──────────────────────────

type PageRef = Pick<KnowledgePageRecord, 'id' | 'kind' | 'labels' | 'parentPageId' | 'spaceId' | 'title'>

/** "Specs / API": a page's folders and its own title, from the space's page list. */
const pathTitle = (page: PageRef, byId: ReadonlyMap<string, PageRef>): string => {
  const titles = [page.title]
  const seen = new Set([page.id])
  for (let parent = page.parentPageId; parent && !seen.has(parent); parent = byId.get(parent)?.parentPageId ?? null) {
    seen.add(parent)
    const folder = byId.get(parent)
    if (!folder) break
    titles.unshift(folder.title)
  }
  return titles.join(' / ')
}

const isUnder = (page: PageRef, folderId: string, byId: ReadonlyMap<string, PageRef>): boolean => {
  const seen = new Set<string>()
  for (let parent = page.parentPageId; parent && !seen.has(parent); parent = byId.get(parent)?.parentPageId ?? null) {
    if (parent === folderId) return true
    seen.add(parent)
  }
  return false
}

export type DocumentPickerOption = { id: string; label: string }

/**
 * The folders a trigger can watch, and the pages it can name: the space's own,
 * each by its path. Pages are the watched kinds only, and inside the chosen
 * folder when there is one, because a page outside it would never fire.
 */
export const documentPickerOptions = (
  pages: readonly PageRef[],
  state: Pick<DocumentTriggerFormState, 'folderPageId' | 'kinds' | 'spaceId'>,
): { folders: DocumentPickerOption[]; pages: DocumentPickerOption[]; labels: string[] } => {
  const inSpace = pages.filter((page) => page.spaceId === state.spaceId)
  const byId = new Map(inSpace.map((page) => [page.id, page]))
  const byLabel = (left: DocumentPickerOption, right: DocumentPickerOption) => left.label.localeCompare(right.label)
  const folders = inSpace
    .filter((page) => page.kind === 'folder')
    .map((page) => ({ id: page.id, label: pathTitle(page, byId) }))
    .sort(byLabel)
  const watched = inSpace.filter((page) =>
    (state.kinds as readonly string[]).includes(page.kind)
    && (!state.folderPageId || isUnder(page, state.folderPageId, byId)))
  const labels = [...new Set(watched.flatMap((page) => page.labels ?? []))].sort((a, b) => a.localeCompare(b))
  return {
    folders,
    labels,
    pages: watched.map((page) => ({ id: page.id, label: pathTitle(page, byId) })).sort(byLabel),
  }
}
