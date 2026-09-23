import {
  DeepWaterNoticeMessageMetadataSchema,
  ResearchRunRefMessageMetadataSchema,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'
import { isResearchNotFound, useResearchRun } from '../../../facades/deep-water/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { ChatCardShell } from '../channels/ChatCardShell'
import { STATUS_LABEL, STATUS_TONE, researchName } from './research-presentation'
import { useResearchBriefDoorway } from './ResearchBriefHost'
import { ResearchRunOutcome } from './ResearchRunOutcome'

/**
 * The research card (docs/standards/agent-cards.md, nessie.md §7.7): a
 * message carrying `metadata.researchRunRef` — written by the server only —
 * renders its run through the viewer's own read, `GET …/research-runs/:runId`,
 * right now. It holds no state of its own, so two readers of one card are
 * owed two answers: the requester sees their brief, someone else in the room
 * sees the launched research, and someone who may not see it is told so. Its
 * actions navigate, download or copy; nothing on it is "pressed".
 */

export const readResearchRunRef = (metadata: Record<string, unknown> | undefined): string | null => {
  const parsed = ResearchRunRefMessageMetadataSchema.shape.researchRunRef.safeParse(metadata?.researchRunRef)
  return parsed.success ? parsed.data.runId : null
}

const statusLine = (run: DeepWaterResearchRunView, meUserId: string | null): string | null => {
  if (run.status !== 'drafting') return null
  if (run.origin.kind === 'agent') return 'An agent is agreeing the brief with DeepWater.'
  return run.requestedByUserId === meUserId
    ? 'You’re agreeing the brief with DeepWater.'
    : 'The brief is being agreed with DeepWater.'
}

/** "Continue the brief" for the requester still agreeing it; "View brief" for everyone else. */
const doorwayLabel = (run: DeepWaterResearchRunView): string =>
  run.status === 'drafting' && run.viewer.canEdit ? 'Continue the brief' : 'View brief'

const Withheld = ({ children }: { children: string }) => (
  <div
    className="mt-2 max-w-[42rem] rounded-md border border-dashed p-3 text-xs"
    data-testid="research-card"
    style={{ background: 'var(--surface-muted)', borderColor: 'var(--border-muted)', color: 'var(--text-muted)' }}
  >
    {children}
  </div>
)

export const ResearchRunCard = ({ metadata }: { metadata: Record<string, unknown> | undefined }) => {
  const runId = readResearchRunRef(metadata)
  return runId ? <ResolvedResearchRunCard runId={runId} /> : null
}

const ResolvedResearchRunCard = ({ runId }: { runId: string }) => {
  const { me } = useAuthSession()
  const doorway = useResearchBriefDoorway()
  const query = useResearchRun(runId)
  const run = query.data && query.data.id === runId ? query.data : null
  const meUserId = me?.user.id ?? null

  if (!run && query.isPending) {
    return (
      <ChatCardShell testId="research-card">
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-3 w-40" />
          <SkeletonBlock className="h-3 w-full" />
        </div>
      </ChatCardShell>
    )
  }
  if (!run) {
    return (
      <Withheld>
        {isResearchNotFound(query.error) ? 'A research you can’t see.' : 'Couldn’t load this research.'}
      </Withheld>
    )
  }

  const line = statusLine(run, meUserId)
  return (
    <ChatCardShell testId="research-card">
      <div className="flex flex-col gap-2" data-status={run.status}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase text-[color:var(--tx3)]">DeepWater research</span>
          <Pill size="sm" tone={STATUS_TONE[run.status]} uppercase={false}>{STATUS_LABEL[run.status]}</Pill>
        </div>
        <p className="text-sm font-semibold text-[color:var(--tx)]">{researchName(run)}</p>
        {line ? <p className="text-sm text-[color:var(--tx2)]">{line}</p> : null}
        <ResearchRunOutcome meUserId={meUserId} onStartAgain={doorway.openNew} run={run} />
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => doorway.open(run)}
            type="button"
          >
            {doorwayLabel(run)}
          </button>
        </div>
      </div>
    </ChatCardShell>
  )
}

/**
 * The actions beside a DeepWater notice or result reply
 * (`metadata.deepWaterNotice`): the result reply offers the artifacts, a
 * blocked delivery its Retry, a failed research its Start again — read live
 * from the run, so an action that no longer applies is gone.
 */
export const ResearchNoticeActions = ({ metadata }: { metadata: Record<string, unknown> | undefined }) => {
  const parsed = DeepWaterNoticeMessageMetadataSchema.safeParse(
    metadata?.deepWaterNotice === undefined ? null : { deepWaterNotice: metadata.deepWaterNotice },
  )
  if (!parsed.success) return null
  const { kind, runId } = parsed.data.deepWaterNotice
  if (kind !== 'result' && kind !== 'blocked' && kind !== 'failed') return null
  return <ResolvedNoticeActions runId={runId} />
}

const ResolvedNoticeActions = ({ runId }: { runId: string }) => {
  const { me } = useAuthSession()
  const doorway = useResearchBriefDoorway()
  const query = useResearchRun(runId)
  const run = query.data && query.data.id === runId ? query.data : null
  if (!run) return null
  return (
    <div className="mt-2" data-testid="research-notice-actions">
      <ResearchRunOutcome actionsOnly meUserId={me?.user.id ?? null} onStartAgain={doorway.openNew} run={run} />
    </div>
  )
}
