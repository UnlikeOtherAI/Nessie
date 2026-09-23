import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { DeepWaterResearchRunView } from '@nessie/schemas'
import { useRetryResearchDelivery } from '../../../facades/deep-water/mutations'
import { briefActionFailure } from './brief-action-errors'
import {
  BLOCKED_REASON_COPY,
  SUMMARY_NOTE,
  reportNoun,
  retryDeliveryLabel,
  sourcesLabel,
} from './research-presentation'
import { ResearchArtifactActions } from './ResearchArtifactActions'
import { startAgainPlace, type StartAgain } from './research-brief-origin'
import { useIntentActionId } from './useIntentActionId'

/**
 * Where a launched research stands, and what the viewer can do about it — the
 * one block the research card, a Knowledge › Research row and the brief dialog
 * all show (Rule zero: one component, never a second rendering). It never
 * calls a summary the full report (amendments N10), names a blocked delivery's
 * one remedy, and offers the artifacts once the result is delivered.
 */

const documentHref = (report: NonNullable<DeepWaterResearchRunView['report']>): string =>
  `/knowledge-base?spaceId=${encodeURIComponent(report.spaceId)}&pageId=${encodeURIComponent(report.pageId)}`

export const ResearchRunOutcome = ({
  actionsOnly = false,
  meUserId,
  onStartAgain,
  run,
}: {
  /**
   * Beside a DeepWater notice or result reply, whose own words already say
   * what happened and link the report: only the actions, never a second
   * telling of the same outcome.
   */
  actionsOnly?: boolean
  meUserId: string | null
  /**
   * A new brief pre-filled with this research's question, coming back where
   * it was asked (its reply thread included); null where none can open.
   */
  onStartAgain: StartAgain | null
  run: DeepWaterResearchRunView
}) => {
  const retry = useRetryResearchDelivery()
  const actionId = useIntentActionId()
  const [retryError, setRetryError] = useState<string | null>(null)
  const ownPersonResearch = run.origin.kind === 'person' && run.requestedByUserId !== null
    && run.requestedByUserId === meUserId

  const retryDelivery = () => {
    setRetryError(null)
    const id = actionId.take({ deliver: run.id })
    retry.mutate({ actionId: id, runId: run.id }, {
      onError: (error) => {
        const failure = briefActionFailure(error)
        actionId.settle(failure.retrySameAction)
        setRetryError(failure.message)
      },
      onSuccess: () => actionId.settle(false),
    })
  }

  const lines: string[] = []
  switch (run.status) {
    case 'starting':
      lines.push('Starting the research…')
      break
    case 'running':
      if (run.delivery.state !== 'blocked') {
        lines.push('DeepWater is researching. The result will come back to this conversation.')
      }
      break
    case 'completed': {
      const sources = sourcesLabel(run.sourceCount)
      if (sources) lines.push(`Finished with ${sources}.`)
      if (run.reportKind === 'summary') lines.push(`${SUMMARY_NOTE}.`)
      if (run.truncated) lines.push(`The ${reportNoun(run.reportKind)} was too long to keep in full, so the end is missing.`)
      break
    }
    case 'failed':
      lines.push(run.failure?.message ?? 'This research didn’t finish.')
      break
    case 'cancelled':
      lines.push('This research was cancelled.')
      break
    case 'drafting':
      break
  }

  const blocked = run.delivery.state === 'blocked' && run.delivery.blockedReason
  return (
    <div className="flex flex-col gap-2" data-testid="research-run-outcome">
      {actionsOnly ? null : lines.map((line) => <p className="text-sm text-[color:var(--tx2)]" key={line}>{line}</p>)}
      {blocked ? (
        <div className="flex flex-wrap items-center gap-2">
          {actionsOnly ? null : (
            <p className="text-sm text-[color:var(--warning-text)]">{BLOCKED_REASON_COPY[blocked]}</p>
          )}
          {run.viewer.canRetryDelivery ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={retry.isPending}
              onClick={retryDelivery}
              type="button"
            >
              {retry.isPending ? 'Retrying…' : retryDeliveryLabel(blocked)}
            </button>
          ) : null}
        </div>
      ) : null}
      {retryError ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{retryError}</p> : null}
      {run.report && !actionsOnly ? (
        <div>
          <Link className="text-sm font-semibold text-[color:var(--accent)]" to={documentHref(run.report)}>
            Open the {reportNoun(run.reportKind)} in Documents
          </Link>
        </div>
      ) : null}
      <ResearchArtifactActions run={run} />
      {run.status === 'failed' && ownPersonResearch && onStartAgain ? (
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => onStartAgain(run.topic, startAgainPlace(run))}
            type="button"
          >
            Start again
          </button>
        </div>
      ) : null}
    </div>
  )
}
