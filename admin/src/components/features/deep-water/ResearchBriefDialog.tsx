import type { DeepWaterBriefOriginRequest } from '@nessie/schemas'
import {
  isResearchNotFound,
  useDeepWaterReadiness,
  useResearchBrief,
} from '../../../facades/deep-water/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { Dialog } from '../../shared/Dialog'
import { BriefWorkspace } from './BriefWorkspace'
import { researchShownIn, type StartAgain } from './research-brief-origin'
import { STATUS_LABEL, STATUS_TONE, researchName } from './research-presentation'
import { ResearchBriefNewForm } from './ResearchBriefNewForm'
import { ResearchReadinessScreen } from './ResearchReadinessScreen'

/**
 * The Research brief dialog — the one surface for agreeing, starting and
 * following a DeepWater research (overview §1 goal 2, nessie.md §7.7). It
 * replaces the launcher form: a new brief asks for the question, then the
 * person and DeepWater's planner agree the pillars and settings before
 * anything is paid for. With no run yet it is gated on readiness, and shows
 * why research cannot start here instead of hiding the doorway.
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
  const shownIn = brief ? researchShownIn(screenOrigin, brief) : 'elsewhere'

  const title = runId ? (brief ? researchName(brief) : 'Research') : 'New research'
  const description = brief ? (
    <span className="flex flex-wrap items-center gap-2">
      <Pill size="sm" tone={STATUS_TONE[brief.status]} uppercase={false}>{STATUS_LABEL[brief.status]}</Pill>
      {brief.title && brief.title.trim() !== brief.topic.trim() ? (
        <span className="text-[color:var(--tx3)]">{brief.topic}</span>
      ) : null}
    </span>
  ) : runId || readiness.state !== 'ready'
    ? undefined
    : 'Agree what to research with DeepWater’s research planner, then start it.'

  const body = () => {
    if (!runId) {
      if (readiness.isLoading) return <Skeleton variant="detail" />
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
    if (briefQuery.isError) {
      return isResearchNotFound(briefQuery.error) ? (
        <p className="text-sm text-[color:var(--tx2)]" data-testid="research-brief-not-found">
          This research isn’t available to you. It may belong to a conversation you can’t see.
        </p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-[color:var(--danger-text)]" role="alert">This research couldn’t be loaded.</p>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => void briefQuery.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      )
    }
    return <Skeleton variant="detail" />
  }

  return (
    <Dialog description={description} onClose={onClose} open size="xl" title={title}>
      <div data-testid="research-brief-dialog">{body()}</div>
    </Dialog>
  )
}
