import type {
  DeepWaterBriefAnalysis,
  DeepWaterDeliveryBlockedReason,
  DeepWaterReportKind,
  DeepWaterResearchReadinessState,
  DeepWaterResearchRunView,
  DeepWaterResearchRunViewStatus,
} from '@nessie/schemas'
import type { PillTone } from '../../primitives/Pill'

/**
 * What a person reads about a DeepWater research, in one place, so the card,
 * the brief dialog, Knowledge › Research and the composer button never say two
 * different things. UK English, plain, second person, and never a vendor,
 * model, price or infrastructure name (nessie.md §7.2).
 */

export const STATUS_LABEL: Record<DeepWaterResearchRunViewStatus, string> = {
  cancelled: 'Cancelled',
  completed: 'Finished',
  drafting: 'Agreeing the brief',
  failed: 'Didn’t finish',
  running: 'Researching',
  starting: 'Starting',
}

export const STATUS_TONE: Record<DeepWaterResearchRunViewStatus, PillTone> = {
  cancelled: 'muted',
  completed: 'success',
  drafting: 'accent',
  failed: 'danger',
  running: 'accent',
  starting: 'accent',
}

/** Terminal views: nothing more will happen to the research itself. */
export const isResearchFinished = (status: DeepWaterResearchRunViewStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/** The research's name: its title once DeepWater has written one, its question until then. */
export const researchName = (run: Pick<DeepWaterResearchRunView, 'title' | 'topic'>): string =>
  run.title?.trim() || run.topic.trim() || 'DeepWater research'

/**
 * The one line a drafting research carries under its name: who is agreeing the
 * brief. Null once it is launched — the outcome says where it stands then.
 */
export const researchStatusLine = (
  run: Pick<DeepWaterResearchRunView, 'origin' | 'requestedByUserId' | 'status'>,
  meUserId: string | null,
): string | null => {
  if (run.status !== 'drafting') return null
  if (run.origin.kind === 'agent') return 'An agent is agreeing the brief with DeepWater.'
  return run.requestedByUserId === meUserId
    ? 'You’re agreeing the brief with DeepWater.'
    : 'The brief is being agreed with DeepWater.'
}

/** "Continue the brief" for the requester still agreeing it; "View brief" for everyone else. */
export const briefDoorwayLabel = (run: Pick<DeepWaterResearchRunView, 'status' | 'viewer'>): string =>
  run.status === 'drafting' && run.viewer.canEdit ? 'Continue the brief' : 'View brief'

/**
 * "full report" only when DeepWater wrote the full report; a summary is always
 * called a summary, and an unknown kind is the neutral "report" (amendments N10).
 */
export const reportNoun = (kind: DeepWaterReportKind | null): string =>
  kind === 'full' ? 'full report' : kind === 'summary' ? 'research summary' : 'report'

export const downloadReportLabel = (kind: DeepWaterReportKind | null): string =>
  kind === 'summary' ? 'Download summary (.md)' : 'Download report (.md)'

/** The one line a summary carries everywhere it is shown (card, reply, list). */
export const SUMMARY_NOTE = 'Research summary (the full report could not be written)'

export const sourcesLabel = (count: number | null): string | null =>
  count === null ? null : `${count} source${count === 1 ? '' : 's'}`

/** Why a finished research could not be saved to Documents, and what to do about it. */
export const BLOCKED_REASON_COPY: Record<DeepWaterDeliveryBlockedReason, string> = {
  knowledge_destination_unavailable:
    'Its page in Documents was deleted or changed before the result could be saved. Retry import puts it back.',
  ledger_unavailable: 'DeepWater couldn’t hand the report over just now. Retry import to try again.',
  report_expired: 'The report is no longer available to import.',
  report_malformed: 'The report couldn’t be read.',
  requester_identity_changed:
    'Your sign-in has changed since you asked for this research. Sign in again, then choose Retry.',
}

/** The one remedy a retryable block names, as its button. */
export const retryDeliveryLabel = (reason: DeepWaterDeliveryBlockedReason | null): string =>
  reason === 'requester_identity_changed' ? 'Retry' : 'Retry import'

// ── Settings (contract §3) ───────────────────────────────────────────────────

export const DEPTH_OPTIONS = [
  { description: 'A quick orientation.', label: 'Light', value: 'light' },
  { description: 'A full report for most decisions.', label: 'Standard', value: 'standard' },
  { description: 'Wider reading and more checking.', label: 'Deep', value: 'deep' },
  { description: 'The broadest, most thorough research.', label: 'Heavy', value: 'heavy' },
] as const

export const CHAPTER_DEPTH_OPTIONS = [
  { label: 'Brief', value: 'brief' },
  { label: 'Standard', value: 'standard' },
  { label: 'Detailed', value: 'detailed' },
  { label: 'Exhaustive', value: 'exhaustive' },
] as const

export const SEARCH_QUALITY_OPTIONS = [
  { label: 'Standard', value: 'standard' },
  { label: 'Premium — reads more results for each search', value: 'premium' },
] as const

export const RECENCY_OPTIONS = [
  { label: 'Any time', value: 'any' },
  { label: 'The past day', value: 'day' },
  { label: 'The past week', value: 'week' },
  { label: 'The past month', value: 'month' },
  { label: 'The past year', value: 'year' },
] as const

export const WRITING_STYLE_OPTIONS = [
  { label: 'Standard', value: 'standard' },
  { label: 'Scientific', value: 'scientific' },
  { label: 'Literary', value: 'literary' },
  { label: 'News weekly', value: 'newsweekly' },
  { label: 'Plain', value: 'plain' },
  { label: 'Narrative', value: 'narrative' },
  { label: 'Explanatory', value: 'explanatory' },
  { label: 'Executive', value: 'executive' },
] as const

export const SETTING_LABEL = {
  chapterDepth: 'Chapter detail',
  depth: 'How thorough',
  languages: 'Source languages',
  outputLanguage: 'Report language',
  recency: 'Sources from',
  searchQuality: 'Source search',
  writingStyle: 'Writing style',
} as const

const optionLabel = (options: readonly { label: string; value: string }[], value: string): string =>
  options.find((option) => option.value === value)?.label ?? value

export const depthLabel = (value: string): string => optionLabel(DEPTH_OPTIONS, value)

let languageNames: Intl.DisplayNames | null | undefined

/** A language's English name ("Czech") from its ISO 639-1 code; the code where the runtime has none. */
export const languageName = (code: string): string => {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(['en-GB'], { type: 'language' })
    } catch {
      languageNames = null
    }
  }
  return languageNames?.of(code) ?? code
}

export const sourceLanguagesLabel = (codes: readonly string[]): string =>
  codes.length === 0 ? 'Any language' : codes.map(languageName).join(', ')

export const COMPLEXITY_LABEL: Record<DeepWaterBriefAnalysis['complexity'], string> = {
  high: 'High',
  low: 'Low',
  medium: 'Medium',
  very_high: 'Very high',
}

// ── Readiness (nessie.md §7.1) ───────────────────────────────────────────────

export type ReadinessCopy = {
  /** What the dialog says, in full. */
  message: string
  /** The composer button's tooltip clause: why it opens this screen, not a brief. */
  reason: string
  title: string
}

export const readinessCopy = (
  state: Exclude<DeepWaterResearchReadinessState, 'ready'>,
  viewerCanChangeTeam: boolean,
): ReadinessCopy => {
  switch (state) {
    case 'team_off':
      return {
        message: viewerCanChangeTeam
          ? 'DeepWater is off for this team. Turn it on to start research from any conversation.'
          : 'DeepWater is off for this team. Ask a team owner or admin to turn it on.',
        reason: 'it’s off for this team',
        title: 'DeepWater is off',
      }
    case 'contract_outdated':
      return {
        message: viewerCanChangeTeam
          ? 'DeepWater needs updating for this team before research can start. Updating takes a moment.'
          : 'DeepWater needs updating for this team. Ask a team owner or admin to update it.',
        reason: 'it needs updating for this team',
        title: 'DeepWater needs updating',
      }
    case 'account_not_linked':
      return {
        message: 'Your sign-in isn’t linked to your organisation’s account for this team. '
          + 'Sign in again with your organisation account to start research.',
        reason: 'sign in again to use it',
        title: 'Sign in to use DeepWater',
      }
    case 'unavailable':
      return {
        message: 'DeepWater can’t be reached for this team right now. Try again in a little while.',
        reason: 'it isn’t available right now',
        title: 'DeepWater isn’t available',
      }
  }
}

/**
 * The composer button always shows; its label says why it would not open a
 * brief. Null while the verdict is still loading: no reason is claimed yet.
 */
export const researchButtonTitle = (
  state: DeepWaterResearchReadinessState | null,
  viewerCanChangeTeam: boolean,
): string =>
  state === null || state === 'ready'
    ? 'Research with DeepWater'
    : `Research with DeepWater — ${readinessCopy(state, viewerCanChangeTeam).reason}`

// ── Time ─────────────────────────────────────────────────────────────────────

/** "12s", "1:05", "1:02:03" — how long the planner has been replying. */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${seconds}s`
}

export const formatResearchDate = (value: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(value))

/**
 * A suggested answer tapped as a reply. It names the question it answers, so
 * the planner is never left guessing which of its questions a short answer
 * belongs to.
 */
export const openQuestionReply = (question: string, answer: string): string =>
  `${question.trim()}\n${answer.trim()}`
