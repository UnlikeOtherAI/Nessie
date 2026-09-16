import {
  faMagnifyingGlassMinus,
  faSpinner,
  faTriangleExclamation,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import {
  KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES,
  type KnowledgeIndexingState,
} from '@nessie/schemas'
import { formatBytes } from '../../../../lib/upload-xhr'

/**
 * One vocabulary for "is this searchable yet?" (uploads-and-indexing.md §4).
 *
 * The same sentence has to come out of three places — the row's glyph tooltip,
 * Get Info's "Search" line, and the menu that offers to retry — and the one
 * failure this module exists to prevent is a spinner that cannot resolve. A
 * draft document has no chunks and never will until somebody publishes it
 * (documents are chunked in `publishPage`), an image is never extracted, and a
 * file over the worker's limit is refused before a job is enqueued. Each of
 * those is `not_indexed` with a reason, and each reason says what it is and,
 * where there is one, what would change it.
 *
 * Exhaustive by construction at every level of the discriminated union: the
 * `state` switch, the `stage` records and the `reason` record are all `Record`s
 * over their literal unions, so a state, stage or reason added to
 * `KnowledgeIndexingStateSchema` fails to compile here rather than rendering a
 * row that says nothing.
 */

/** What the trailing glyph is, if any. `none` is the quiet, common case. */
export type IndexingGlyphKind = 'none' | 'pending' | 'not-indexed' | 'failed'

type PendingStage = Extract<KnowledgeIndexingState, { state: 'pending' }>['stage']
type FailedStage = Extract<KnowledgeIndexingState, { state: 'failed' }>['stage']
type NotIndexedReason = Extract<KnowledgeIndexingState, { state: 'not_indexed' }>['reason']

export type IndexingCopy = {
  glyph: IndexingGlyphKind
  /** The FontAwesome glyph, or null where the row says nothing. */
  icon: IconDefinition | null
  /** The CSS custom property *name* the glyph is painted with. */
  tone: string
  /** Spins: only ever true while the pipeline is actually working. */
  spin: boolean
  /** The tooltip, the glyph's `aria-label`, and Get Info's "Search" line. */
  sentence: string
  /** Where "Retry indexing" (`POST /pages/:id/reindex`) is offered. */
  retry: boolean
  /** Whether this row should keep the folder's list polling (§4, freshness). */
  pending: boolean
}

/**
 * The worker's own ceiling, rendered the way a person reads it. Exported so
 * Get Info and a refusal notice cannot drift into a second number.
 */
export const MAX_INDEXABLE_BYTES = KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES
export const MAX_INDEXABLE_LABEL = formatBytes(KNOWLEDGE_EXTRACT_MAX_ATTACHMENT_BYTES)

const quiet = (sentence: string): IndexingCopy => ({
  glyph: 'none',
  icon: null,
  pending: false,
  retry: false,
  sentence,
  spin: false,
  tone: '--tx3',
})

const notIndexed = (sentence: string): IndexingCopy => ({
  glyph: 'not-indexed',
  icon: faMagnifyingGlassMinus,
  pending: false,
  retry: false,
  sentence,
  spin: false,
  tone: '--tx3',
})

const working = (sentence: string): IndexingCopy => ({
  glyph: 'pending',
  icon: faSpinner,
  pending: true,
  retry: false,
  sentence,
  spin: true,
  tone: '--tx3',
})

const failed = (): IndexingCopy => ({
  glyph: 'failed',
  icon: faTriangleExclamation,
  pending: false,
  retry: true,
  sentence: 'Indexing failed',
  spin: false,
  tone: '--warning',
})

const PENDING: Record<PendingStage, IndexingCopy> = {
  // Text is still being pulled out of the file.
  extract: working('Indexing…'),
  // The chunks exist; their embeddings are still being written.
  embed: working('Preparing search…'),
}

// Both stages read the same to a person: the pipeline gave up and the row
// offers to start it again. Which job it was belongs in `queue_jobs`, not on
// a row in a folder.
const FAILED: Record<FailedStage, IndexingCopy> = {
  extract: failed(),
  embed: failed(),
}

/**
 * The unsupported sentence names the family, because "this file type" tells a
 * person nothing they did not already know. The plural is the family label's —
 * every value of `familyLabel` pluralises with an `s`.
 */
const unsupportedSentence = (familyLabel?: string): string =>
  familyLabel
    ? `Not indexed — ${familyLabel}s aren't searchable`
    : "Not indexed — this kind of file isn't searchable"

const REASONS: Record<NotIndexedReason, (familyLabel?: string) => IndexingCopy> = {
  // A draft is honestly unsearchable and its status pill already says "draft",
  // so the row stays quiet; only the sentence explains, and it names the one
  // thing that would change it. Never a spinner: nothing is running, and
  // nothing will until somebody publishes.
  draft: () => quiet('Not indexed — draft documents are indexed when published'),
  unsupported: (familyLabel) => notIndexed(unsupportedSentence(familyLabel)),
  too_large: () => notIndexed(`Not indexed — larger than ${MAX_INDEXABLE_LABEL}`),
  empty: () => notIndexed('Not indexed — no text found'),
}

/**
 * What the screen says about one row's indexing.
 *
 * `familyLabel` is the row's family word (`familyLabel[familyForRow(page)]`),
 * read only by the `unsupported` reason.
 */
export const indexingCopy = (
  indexing: KnowledgeIndexingState,
  familyLabel?: string,
): IndexingCopy => {
  switch (indexing.state) {
    // A folder. There is nothing inside a folder row to index.
    case 'not_applicable':
      return quiet('')
    // Every chunk of the current version carries an embedding. Quiet on
    // purpose: a tick on every row of a folder says only that the folder
    // exists.
    case 'indexed':
      return quiet('Searchable')
    case 'pending':
      return PENDING[indexing.stage]
    case 'not_indexed':
      return REASONS[indexing.reason](familyLabel)
    case 'failed':
      return FAILED[indexing.stage]
    default: {
      const exhaustive: never = indexing
      return exhaustive
    }
  }
}

/**
 * Whether a loaded list still has work in flight, and so whether the Finder
 * should keep asking. An absent `indexing` is not pending: a row from a
 * listing that predates the enrichment must not start a poll that never stops.
 */
export const hasPendingIndexing = (
  rows: readonly { indexing?: KnowledgeIndexingState }[],
): boolean => rows.some((row) => Boolean(row.indexing && indexingCopy(row.indexing).pending))
