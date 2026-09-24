import type { DeepWaterResearchRunView } from '@nessie/schemas'
import { briefDoorwayLabel, researchStatusLine } from './research-presentation'
import { useResearchBriefDoorway } from './ResearchBriefHost'
import type { ResearchShownIn } from './research-brief-origin'
import { ResearchRunOutcome } from './ResearchRunOutcome'

/**
 * Everything a research says under its name, wherever it is listed — the
 * research card in a thread and a Knowledge › Research row (Rule zero: one
 * rendering, parameterised by where it sits): who is agreeing the brief, where
 * the research stands with its artifacts, and the way into its brief.
 */
export const ResearchRunBody = ({
  meUserId,
  run,
  shownIn,
}: {
  meUserId: string | null
  run: DeepWaterResearchRunView
  /** The card sits in the research's own conversation; a Knowledge › Research row does not. */
  shownIn: ResearchShownIn
}) => {
  const doorway = useResearchBriefDoorway()
  const line = researchStatusLine(run, meUserId)
  return (
    <div className="flex flex-col gap-2">
      {line ? <p className="text-sm text-[color:var(--tx2)]">{line}</p> : null}
      <ResearchRunOutcome meUserId={meUserId} onStartAgain={doorway.openNew} run={run} shownIn={shownIn} />
      <div>
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          data-testid="research-brief-doorway"
          onClick={() => doorway.open(run)}
          type="button"
        >
          {briefDoorwayLabel(run)}
        </button>
      </div>
    </div>
  )
}
