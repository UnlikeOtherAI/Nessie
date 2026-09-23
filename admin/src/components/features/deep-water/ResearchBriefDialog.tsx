import type { DeepWaterBriefOriginRequest, DeepWaterResearchRunView } from '@nessie/schemas'
import {
  isResearchNotFound,
  useDeepWaterReadiness,
  useResearchBrief,
  useResearchRun,
} from '../../../facades/deep-water/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { Dialog } from '../../shared/Dialog'
import { BriefWorkspace } from './BriefWorkspace'
import { researchShownIn, type ResearchShownIn, type StartAgain } from './research-brief-origin'
import { STATUS_LABEL, STATUS_TONE, researchName } from './research-presentation'
import { ResearchBriefNewForm } from './ResearchBriefNewForm'
import { ResearchReadinessScreen, ResearchReadinessUnread } from './ResearchReadinessScreen'
import { ResearchRunOutcome } from './ResearchRunOutcome'

/**
 * The Research brief dialog — the one surface for agreeing, starting and
 * following a DeepWater research (overview §1 goal 2, nessie.md §7.7). It
 * replaces the launcher form: a new brief asks for the question, then the
 * person and DeepWater's planner agree the pillars and settings before
 * anything is paid for. With no run yet it is gated on readiness, and shows
 * why research cannot start here instead of hiding the doorway.
 *
 * A research started from the launcher, before briefs, has no brief: its
 * brief read answers 404 while the research itself is still the viewer's to
 * read, so the dialog shows where that research stands instead of telling
 * its own requester it is not theirs to see.
 */

export const ResearchBriefDialog = ({
  initialTopic,
  onClose,
  onCreated,
  onStartAgain,
  origin,
  runId,
  screenOrigin,
}: {
  initialTopic: string
  onClose: () => void
  onCreated: (runId: string) => void
  onStartAgain: StartAgain
  /** Where a new brief's result comes back. */
  origin: DeepWaterBriefOriginRequest | null
  runId: string | null
  /** The conversation the screen under the dialog shows, if it shows one. */
  screenOrigin: DeepWaterBriefOriginRequest | null
}) => {
  const { me } = useAuthSession()
  const readiness = useDeepWaterReadiness()
  const briefQuery = useResearchBrief(runId)
  const brief = briefQuery.data && briefQuery.data.id === runId ? briefQuery.data : null
  const noBrief = briefQuery.isError && isResearchNotFound(briefQuery.error)
  const runQuery = useResearchRun(noBrief ? runId : null)
  const runWithoutBrief = noBrief && runQuery.data && runQuery.data.id === runId ? runQuery.data : null
  const shown = brief ?? runWithoutBrief
  const shownIn = shown ? researchShownIn(screenOrigin, shown) : 'elsewhere'

  const title = runId ? (shown ? researchName(shown) : 'Research') : 'New research'
  const description = shown ? (
    <span className="flex flex-wrap items-center gap-2">
      <Pill size="sm" tone={STATUS_TONE[shown.status]} uppercase={false}>{STATUS_LABEL[shown.status]}</Pill>
      {shown.title && shown.title.trim() !== shown.topic.trim() ? (
        <span className="text-[color:var(--tx3)]">{shown.topic}</span>
      ) : null}
    </span>
  ) : runId || readiness.state !== 'ready'
    ? undefined
    : 'Agree what to research with DeepWater’s research planner, then start it.'

  const failedToLoad = (retry: () => void) => (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-[color:var(--danger-text)]" role="alert">This research couldn’t be loaded.</p>
      <button className="admin-button admin-button-secondary admin-button-compact" onClick={retry} type="button">
        Try again
      </button>
    </div>
  )

  const body = () => {
    if (!runId) {
      if (readiness.state === null) {
        return readiness.isError ? <ResearchReadinessUnread onRetry={readiness.retry} /> : <Skeleton variant="detail" />
      }
      if (readiness.state !== 'ready') {
        return (
          <ResearchReadinessScreen
            onClose={onClose}
            state={readiness.state}
            viewerIsOwner={readiness.viewerIsOwner}
          />
        )
      }
      if (!origin) {
        return (
          <p className="text-sm text-[color:var(--tx2)]">
            Open a conversation first: the research comes back to the conversation it was started from.
          </p>
        )
      }
      return <ResearchBriefNewForm initialTopic={initialTopic} onCreated={onCreated} origin={origin} />
    }
    if (brief && me) {
      return <BriefWorkspace brief={brief} meUserId={me.user.id} onStartAgain={onStartAgain} shownIn={shownIn} />
    }
    if (runWithoutBrief) {
      return (
        <ResearchWithoutBrief
          meUserId={me?.user.id ?? null}
          onStartAgain={onStartAgain}
          run={runWithoutBrief}
          shownIn={shownIn}
        />
      )
    }
    if (briefQuery.isError && !noBrief) return failedToLoad(() => void briefQuery.refetch())
    if (noBrief && runQuery.isError) {
      return isResearchNotFound(runQuery.error) ? (
        <p className="text-sm text-[color:var(--tx2)]" data-testid="research-brief-not-found">
          This research isn’t available to you. It may belong to a conversation you can’t see.
        </p>
      ) : failedToLoad(() => void runQuery.refetch())
    }
    return <Skeleton variant="detail" />
  }

  return (
    <Dialog description={description} onClose={onClose} open size="xl" title={title}>
      <div data-testid="research-brief-dialog">{body()}</div>
    </Dialog>
  )
}

/** A research from before briefs: where it stands and what it produced, with nothing to agree. */
const ResearchWithoutBrief = ({ meUserId, onStartAgain, run, shownIn }: {
  meUserId: string | null
  onStartAgain: StartAgain
  run: DeepWaterResearchRunView
  shownIn: ResearchShownIn
}) => (
  <div className="flex flex-col gap-3" data-testid="research-without-brief">
    <p className="text-sm text-[color:var(--tx2)]">
      This research was started before research briefs, so it has no brief to show.
    </p>
    <ResearchRunOutcome meUserId={meUserId} onStartAgain={onStartAgain} run={run} shownIn={shownIn} />
  </div>
)
