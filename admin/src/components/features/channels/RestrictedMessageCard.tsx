import { useState } from 'react'

/**
 * The acknowledgement card.
 *
 * A reply the agent built from sources this reader cannot reach shows a
 * placeholder rather than nothing — a silent gap reads as a bug, and leaves
 * people unable to tell whether the conversation jumped or the product broke.
 *
 * Someone who *can* reach those sources additionally gets the controls to lift
 * the restriction: share this one reply, or stand up a rule for this agent in
 * this channel. Only the server decides whether those controls do anything —
 * this component asks, it never authorizes.
 */

export type DisclosureDuration = '10m' | 'today' | '30d' | 'forever'

const DURATION_LABELS: Record<DisclosureDuration, string> = {
  '10m': 'for 10 minutes',
  today: 'for the rest of today',
  '30d': 'for 30 days',
  forever: 'until I revoke it',
}

type Props = {
  messageId: string
  /**
   * `withheld` — the viewer cannot reach this reply's sources, so they see a
   * placeholder and nothing else. They can never be the one to share it: being
   * withheld *means* failing the basis, and failing the basis means you cannot
   * grant it. The two states are mutually exclusive by construction.
   *
   * `shareable` — the viewer reads the reply normally and is the person who can
   * lift the restriction for everyone else.
   */
  mode: 'withheld' | 'shareable'
  /** Whether a standing rule is offered at all — private material gets none. */
  allowStanding: boolean
  onShare: (input: { kind: 'message' | 'scope'; duration: DisclosureDuration }) => Promise<void>
}

export const RestrictedMessageCard = ({
  messageId,
  mode,
  allowStanding,
  onShare,
}: Props) => {
  const [duration, setDuration] = useState<DisclosureDuration>('10m')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'message' | 'scope'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onShare({ duration, kind })
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Could not share this reply.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="rounded-md border border-dashed p-3 text-sm"
      style={{
        borderColor: 'var(--border-muted)',
        background: 'var(--surface-muted)',
        color: 'var(--text-muted)',
      }}
      data-testid={`restricted-message-${messageId}`}
    >
      <p className="m-0">
        {mode === 'withheld'
          ? 'This reply used sources you don’t have access to, so it isn’t shown.'
          : 'This reply used sources that aren’t shared with everyone in this channel.'}
      </p>

      {mode === 'shareable' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={() => void run('message')}
            type="button"
          >
            Share this reply
          </button>

          {allowStanding ? (
            <>
              <select
                aria-label="How long to allow this"
                className="admin-input"
                disabled={busy}
                onChange={(event) => setDuration(event.target.value as DisclosureDuration)}
                value={duration}
              >
                {(Object.keys(DURATION_LABELS) as DisclosureDuration[]).map((value) => (
                  <option key={value} value={value}>
                    {DURATION_LABELS[value]}
                  </option>
                ))}
              </select>
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={() => void run('scope')}
                type="button"
              >
                Always allow here
              </button>
            </>
          ) : (
            <span className="text-xs">
              This material is private, so it can only be shared one reply at a time.
            </span>
          )}
        </div>
      ) : (
        <p className="m-0 mt-2 text-xs">
          Ask someone with access to share it.
        </p>
      )}

      {error ? (
        <p className="m-0 mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
