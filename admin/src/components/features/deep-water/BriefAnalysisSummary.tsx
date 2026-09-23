import type { DeepWaterBriefAnalysis, DeepWaterBriefDepth } from '@nessie/schemas'
import { SectionLabel } from '../../primitives/SectionLabel'
import { COMPLEXITY_LABEL, depthLabel } from './research-presentation'

/**
 * The planner's read of the question: how it would go about it, how hard it
 * is, what sources it expects and what to be careful of — and the depth it
 * suggests, which the person can take with one tap. The planner never sets the
 * depth by suggesting it; "How thorough" is still the person's to choose.
 */
export const BriefAnalysisSummary = ({
  analysis,
  currentDepth,
  onUseSuggestedDepth,
}: {
  analysis: DeepWaterBriefAnalysis | null
  currentDepth: DeepWaterBriefDepth
  /** Null when the viewer cannot change the brief. */
  onUseSuggestedDepth: (() => void) | null
}) => {
  if (!analysis) return null
  const facts: Array<[string, string]> = [
    ['Complexity', COMPLEXITY_LABEL[analysis.complexity]],
    ['How current the sources are', analysis.dataFreshness],
    ['How reliable it is likely to be', analysis.estimatedReliability],
  ]
  return (
    <section aria-label="The planner’s assessment" className="flex flex-col gap-2" data-testid="research-brief-analysis">
      <h3><SectionLabel as="span" size="sm">The planner’s assessment</SectionLabel></h3>
      {analysis.approach ? <p className="text-sm text-[color:var(--tx)]">{analysis.approach}</p> : null}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {facts.filter(([, value]) => value.trim() !== '').map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-[color:var(--tx3)]">{label}</dt>
            <dd className="text-[color:var(--tx2)]">{value}</dd>
          </div>
        ))}
        {analysis.sourceTypes.length > 0 ? (
          <div className="contents">
            <dt className="text-[color:var(--tx3)]">Sources it will look for</dt>
            <dd className="text-[color:var(--tx2)]">{analysis.sourceTypes.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {analysis.caveats.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-[color:var(--tx2)]">
          {analysis.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
        </ul>
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--tx)]" data-testid="research-suggested-depth">
        <span>
          Suggested depth: <strong>{depthLabel(analysis.recommendedDepth)}</strong>
        </span>
        {onUseSuggestedDepth && analysis.recommendedDepth !== currentDepth ? (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={onUseSuggestedDepth}
            type="button"
          >
            Use {depthLabel(analysis.recommendedDepth)}
          </button>
        ) : null}
      </p>
    </section>
  )
}
