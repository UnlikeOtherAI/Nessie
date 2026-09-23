import { useState } from 'react'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { Switch } from '../../primitives/Switch'

/**
 * The foot of a brief: the person-only choice to publish the finished report
 * (nessie.md §7.9 — an agent's brief is always private, and Ledger enforces
 * that from the signed author), Start, and a way to give the research up.
 * Start is the dialog's one primary action; it is explained, not just greyed,
 * when it cannot be pressed yet.
 */

export type StartBarProps = {
  brief: DeepWaterBriefView
  /** The requester's own brief, still being agreed: Start and the publish switch belong here. */
  canOfferStart: boolean
  cancelling: boolean
  /** Why Start cannot be pressed yet, in words; null when it can. */
  blockedReason: string | null
  error: string | null
  onCancel: (() => void) | null
  onPublishChange: (publish: boolean) => void
  onStart: () => void
  publish: boolean
  starting: boolean
}

export const BriefStartBar = ({
  blockedReason,
  brief,
  canOfferStart,
  cancelling,
  error,
  onCancel,
  onPublishChange,
  onStart,
  publish,
  starting,
}: StartBarProps) => {
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const personBrief = brief.origin.kind === 'person'
  const drafting = brief.status === 'drafting'
  const cancelWord = drafting ? 'Discard brief' : 'Cancel research'

  return (
    <div className="flex flex-col gap-3 border-t border-[color:var(--sep)] pt-3" data-testid="research-brief-start">
      {canOfferStart ? (
        <div className="flex items-start gap-3">
          <Switch checked={publish} label="Publish on research.deepwater.live" onChange={onPublishChange} />
          <div className="flex flex-col">
            <span className="text-sm font-medium text-[color:var(--tx)]">Publish on research.deepwater.live</span>
            <span className="text-xs text-[color:var(--tx3)]">
              Anyone with the link can read the finished report.
            </span>
          </div>
        </div>
      ) : null}
      {!personBrief ? (
        <p className="text-xs text-[color:var(--tx3)]">
          An agent started this research, so it stays private to the people who can see this conversation.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {brief.ready && drafting ? (
          <span className="mr-auto text-xs text-[color:var(--tx2)]">DeepWater thinks this brief is ready.</span>
        ) : null}
        {onCancel && !confirmingCancel ? (
          <button
            className="admin-button admin-button-secondary"
            disabled={cancelling}
            onClick={() => setConfirmingCancel(true)}
            type="button"
          >
            {cancelWord}
          </button>
        ) : null}
        {onCancel && confirmingCancel ? (
          <span className="flex flex-wrap items-center gap-2" role="group" aria-label={cancelWord}>
            <span className="text-sm text-[color:var(--tx2)]">
              {drafting ? 'Discard this brief?' : 'Stop this research? It can’t be resumed.'}
            </span>
            <button
              className="admin-button admin-button-secondary admin-button-danger"
              disabled={cancelling}
              onClick={() => {
                setConfirmingCancel(false)
                onCancel()
              }}
              type="button"
            >
              {cancelling ? 'Cancelling…' : drafting ? 'Discard' : 'Stop research'}
            </button>
            <button className="admin-button admin-button-secondary" onClick={() => setConfirmingCancel(false)} type="button">
              Keep it
            </button>
          </span>
        ) : null}
        {canOfferStart ? (
          <button
            className="admin-button admin-button-primary"
            disabled={blockedReason !== null || starting}
            onClick={onStart}
            title={blockedReason ?? undefined}
            type="button"
          >
            {starting ? 'Starting…' : 'Start research'}
          </button>
        ) : null}
      </div>
      {canOfferStart && blockedReason ? (
        <p className="text-right text-xs text-[color:var(--tx3)]">{blockedReason}</p>
      ) : null}
      {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
