import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import i18n from '../../../../i18n/i18n'
import { finderText } from './finder-text'

/**
 * Every sentence the move-or-copy surfaces say, as pure functions.
 *
 * They are here rather than inside the components because three call sites
 * share them — the drop-point menu, Move to…'s footer and the tray row — and
 * because the audience line is the one thing in this feature that must be
 * *exactly* right: it is what `acknowledged: true` claims the person was told
 * before an audience was widened (transfer.md §1, §4.1).
 *
 * The audience is derived from the destination space the way
 * `destinationScopeForSpace` derives its scope. It is not imported from
 * `@nessie/knowledge`: that module resolves `@prisma/client` at its first
 * import, which is not a thing a browser bundle can contain. The switch below
 * is over the same `visibility` column in the same order, and the unit suite
 * pins every arm.
 */

/** A root folder a transfer can land in, as the root column already knows it. */
export type TransferDestination = {
  spaceId: string
  name: string
  visibility: KnowledgeRootSpace['visibility']
  ownerAgentId: string | null
  projectName: string | null
  canWrite: boolean
  /** Which group of the root column it came from. */
  role: 'personal' | 'project' | 'shared'
}

export const destinationsFromRoot = (root: KnowledgeRoot | undefined): TransferDestination[] => {
  if (!root) return []
  const of = (
    space: KnowledgeRootSpace,
    role: TransferDestination['role'],
  ): TransferDestination => ({
    canWrite: space.canWrite,
    name: space.name,
    ownerAgentId: space.ownerAgentId,
    projectName: space.projectName,
    role,
    spaceId: space.spaceId,
    visibility: space.visibility,
  })
  return [
    of(root.myDocuments, 'personal'),
    ...root.projects.map((project) => of(project.space, 'project')),
    ...root.agentHomes.map((space) => of(space, 'shared')),
    ...root.shared.map((space) => of(space, 'shared')),
  ]
}

const itOrThem = (count: number): string => finderText(count === 1 ? 'transferSubjectOne' : 'transferSubjectOther', count === 1 ? 'it' : 'them')

/**
 * "Everyone in the project P will see it." — the line the person has to have
 * read before `acknowledged: true` is true.
 */
export const transferAudienceLine = (
  destination: TransferDestination,
  count: number,
): string => {
  const subject = itOrThem(count)
  // An agent's home first: its `visibility` is whatever the agent's owner made
  // it, and "people who can see the agent" is the audience either way.
  if (destination.ownerAgentId) {
    return finderText('transferAudienceAgent', 'People who can see the agent {{name}} will see {{subject}}.', { name: destination.name, subject })
  }
  if (destination.role === 'personal') return finderText('transferAudiencePersonal', 'Only you will see {{subject}}.', { subject })
  if (destination.role === 'project' || destination.visibility === 'project') {
    const project = destination.projectName ?? destination.name
    return finderText('transferAudienceProject', 'Everyone in the project {{name}} will see {{subject}}.', { name: project, subject })
  }
  if (destination.visibility === 'organization') {
    return finderText('transferAudienceOrg', 'Everyone in the organisation will see {{subject}}.', { subject })
  }
  return finderText('transferAudienceShared', 'People added to {{name}} will see {{subject}}.', { name: destination.name, subject })
}

const items = (count: number): string => finderText(count === 1 ? 'itemCount_one' : 'itemCount_other', count === 1 ? '{{count}} item' : '{{count}} items', { count })

/**
 * "Move or copy “Plan” to P?" for one row, "Move or copy 3 items to P?" for a
 * selection. The curly quotes are literal: they are the ones every refusal
 * sentence the server writes already uses.
 */
export const transferPromptHeading = (input: {
  count: number
  destinationName: string
  title?: string
}): string => {
  const what = input.count === 1 && input.title ? `“${input.title}”` : items(input.count)
  return finderText('transferPromptHeading', 'Move or copy {{what}} to {{destination}}?', { what, destination: input.destinationName })
}

/** The dialog's title, which changes the moment a foreign root is picked. */
export const moveToDialogTitle = (input: {
  count: number
  crossRoot: boolean
}): string =>
  input.crossRoot
    ? finderText('transferMoveOrCopyTitle', 'Move or copy {{count}} items…', { count: input.count })
    : finderText('transferMoveTitle', 'Move {{count}} items to…', { count: input.count })

/**
 * The blunt one. A move out of a personal space deletes every share on the
 * subtree, and the person finds out here or after the fact.
 */
export const transferSharingLine = (shareCount: number): string | null =>
  shareCount > 0
    ? finderText(shareCount === 1 ? 'transferSharingEnds_one' : 'transferSharingEnds_other', shareCount === 1 ? 'Sharing with {{count}} person ends.' : 'Sharing with {{count}} people ends.', { count: shareCount })
    : null

/**
 * A refusal's sentence. The server writes most of them to the character
 * (`packages/knowledge/src/transfer/collect.ts`), so its message is preferred
 * and this only fills the codes it has no sentence for — and the one the
 * design words differently from the storage layer that raises it.
 */
export const transferRefusalSentence = (
  code: string | undefined,
  message: string | undefined,
): string => {
  switch (code) {
    case 'STORAGE_QUOTA_EXCEEDED':
      return finderText('transferRefusalQuota', 'Not copied — storage is full.')
    case 'TRANSFER_NOT_ACKNOWLEDGED':
      return finderText('transferRefusalNotConfirmed', 'That move was not confirmed. Try the drag again.')
    case 'TRANSFER_MIXED_SOURCES':
      return finderText('transferRefusalMixed', 'Move or copy items from one root folder at a time.')
    default:
      return message && message.trim().length > 0
        ? message
        : finderText('transferRefusalDefault', 'Those items could not be moved.')
  }
}

export type TransferProgress = {
  operation: 'move' | 'copy'
  status: 'queued' | 'running' | 'done' | 'failed'
  done: number
  total: number
  error: string | null
  count: number
  destinationName: string
  sourceName: string
}

const number = (value: number): string => value.toLocaleString(i18n.language)

/**
 * What the tray says, and the one place the two operations must not be blurred.
 *
 * A failed **copy** rolled everything back — no page, no byte, no ledger event
 * survived, so the sentence says nothing was copied. A failed **move** kept the
 * batches that committed: each rewrote its pages *and* their chunks, so those
 * rows are consistent in their new home and the rest never left. Saying "the
 * move failed" over that would be a lie about where a person's documents are.
 */
export const transferProgressSentence = (progress: TransferProgress): string => {
  const verb = finderText(progress.operation === 'move' ? 'transferVerbMove' : 'transferVerbCopy', progress.operation === 'move' ? 'Moving' : 'Copying')
  switch (progress.status) {
    case 'queued':
    case 'running':
      return progress.total > 0
        ? finderText('transferProgressRunning', '{{verb}} {{count}}… {{done}} of {{total}}', {
            verb, count: items(progress.count), done: number(progress.done), total: number(progress.total),
          })
        : finderText('transferProgressRunningIndeterminate', '{{verb}} {{count}}…', {
            verb, count: items(progress.count),
          })
    case 'done':
      return progress.operation === 'move'
        ? finderText('transferProgressDoneMove', 'Moved {{count}} items to {{destination}}', { count: items(progress.total || progress.count), destination: progress.destinationName })
        : finderText('transferProgressDoneCopy', 'Copied {{count}} items to {{destination}}', { count: items(progress.total || progress.count), destination: progress.destinationName })
    default:
      break
  }
  const reason = progress.error ? ` — ${progress.error}` : ''
  if (progress.operation === 'copy') {
    return finderText('transferProgressFailedCopy', 'Nothing was copied{{reason}}. Everything stayed in {{source}}.', { reason, source: progress.sourceName })
  }
  return finderText('transferProgressFailedMove', 'Moved {{done}} of {{total}}{{reason}}. The rest stayed in {{source}}.', { done: number(progress.done), total: number(progress.total), reason, source: progress.sourceName })
}
