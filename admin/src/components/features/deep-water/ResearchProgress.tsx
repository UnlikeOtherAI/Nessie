import type { DeepWaterResearchRunView } from '@nessie/schemas'
import { progressHeadline, sourcesFoundLabel } from './research-presentation'
import { useElapsed } from './useElapsed'

/**
 * Where a running research stands, as DeepWater last said (Water plan
 * amendments-streaming S2): the phase in Nessie's words, DeepWater's own words
 * for the step, a bar when the step is countable, the sources found so far and
 * how long it has been running. The run view is refetched on every
 * `integration.run.updated` over the shared event stream, so this moves as
 * DeepWater pushes; the only timer here is the clock's display tick, which
 * fetches nothing. Shown by `ResearchRunOutcome`, so the card, a Knowledge ›
 * Research row and the brief dialog read the same.
 */
export const ResearchProgress = ({ run }: { run: Pick<DeepWaterResearchRunView, 'progress' | 'startedAt'> }) => {
  const { progress } = run
  const elapsed = useElapsed(run.startedAt)
  const facts = [sourcesFoundLabel(progress?.sourcesFound ?? null), elapsed ? `Running for ${elapsed}` : null]
    .filter((fact): fact is string => fact !== null)
  if (!progress && facts.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-phase={progress?.phase ?? 'unknown'} data-testid="research-progress">
      {progress ? (
        <>
          <p className="text-sm font-semibold text-[color:var(--tx)]">{progressHeadline(progress.phase)}</p>
          <p className="text-sm text-[color:var(--tx2)]">{progress.note}</p>
          {progress.percent !== null ? (
            <div className="flex items-center gap-2">
              <span
                aria-label={`${progress.percent}% of this step done`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress.percent}
                className="h-1.5 w-full max-w-[16rem] overflow-hidden rounded-full bg-[color:var(--overlay)]"
                role="progressbar"
              >
                <span
                  className="block h-full bg-[color:var(--accent)] transition-[width] duration-500"
                  style={{ width: `${progress.percent}%` }}
                />
              </span>
              <span className="text-xs tabular-nums text-[color:var(--tx3)]">{progress.percent}%</span>
            </div>
          ) : null}
        </>
      ) : null}
      {facts.length > 0 ? (
        <p className="text-xs tabular-nums text-[color:var(--tx3)]" data-testid="research-progress-facts">
          {facts.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
