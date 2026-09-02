import { useState } from 'react'
import { Pill } from '../../primitives/Pill'
import {
  useDiscardGmailDraft,
  useGmailDraft,
  useSendGmailDraft,
  useUndoGmailSend,
  type GmailDraftView,
} from '../../../facades/gmail/hooks'

/**
 * The email draft card.
 *
 * Rendered from message metadata `{ card: { kind: 'gmail_draft', draftActionId } }`,
 * which is server-authored and carries IDENTIFIERS ONLY. Recipients, subject
 * and body are fetched from an owner-gated route that answers an
 * indistinguishable 404 to anybody else — message metadata is readable by
 * everyone who can read the message, so putting the subject line there would
 * leak the one thing this is meant to protect.
 *
 * Two action modes share this one component: a person acting on their own
 * draft, and an approver resolving an agent's request to send it.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readGmailDraftCard = (
  metadata: Record<string, unknown> | undefined,
): { draftActionId: string } | null => {
  const card = metadata?.card
  if (!isRecord(card) || card.kind !== 'gmail_draft') return null
  const draftActionId = card.draftActionId
  return typeof draftActionId === 'string' ? { draftActionId } : null
}

const AddressRow = ({ label, values }: { label: string; values: string[] }) =>
  values.length === 0 ? null : (
    <div className="flex gap-2 text-xs">
      <span className="w-10 shrink-0 text-[color:var(--tx3)]">{label}</span>
      <span className="min-w-0 break-words text-[color:var(--tx)]">
        {values.join(', ')}
      </span>
    </div>
  )

/**
 * The presentational half, kept pure so every state — draft, held, sent,
 * discarded — is testable without a query client or a live mailbox.
 */
export const GmailDraftCardView = ({
  data,
  busy = false,
  error = null,
  onSend,
  onUndo,
  onDiscard,
}: {
  data: GmailDraftView
  busy?: boolean
  error?: string | null
  onSend?: () => void
  onUndo?: () => void
  onDiscard?: () => void
}) => {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3"
      data-testid="gmail-draft-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase text-[color:var(--tx3)]">
          Email draft
        </span>
        {data.state === 'sent' ? (
          <Pill radius="chip" size="sm" tone="success" uppercase={false}>
            Sent
          </Pill>
        ) : data.state === 'sending' ? (
          <Pill radius="chip" size="sm" tone="warning" uppercase={false}>
            Sending…
          </Pill>
        ) : data.state === 'discarded' ? (
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            Discarded
          </Pill>
        ) : null}
      </div>

      <div className="mt-2 grid gap-1">
        <AddressRow label="To" values={data.to} />
        <AddressRow label="Cc" values={data.cc} />
        <AddressRow label="Bcc" values={data.bcc} />
      </div>

      <div className="mt-2 text-sm font-semibold text-[color:var(--tx)]">
        {data.subject || '(no subject)'}
      </div>
      {/* Clamped, never an inner scroll region: a scrollbar inside the feed's
          own scroll is a trap, and a live decision is allowed to be tall. */}
      <div
        className={[
          'mt-1 whitespace-pre-wrap rounded border border-[color:var(--sep)]',
          'bg-[color:var(--overlay-weak)] p-2 text-xs leading-5 text-[color:var(--tx2)]',
          expanded ? '' : 'line-clamp-[12]',
        ].join(' ')}
      >
        {data.body}
      </div>
      {data.body.length > 600 ? (
        <button
          className="mt-1 text-[11px] font-semibold text-[color:var(--accent)]"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? 'Show less' : 'Show full email'}
        </button>
      ) : null}

      {data.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {/* Keyed by index: two attachments can share a filename. */}
          {data.attachments.map((attachment, index) => (
            <span
              className="rounded border border-[color:var(--sep)] px-2 py-0.5 text-[11px] text-[color:var(--tx2)]"
              key={`${attachment.filename}-${index}`}
            >
              {attachment.filename}
              {attachment.sizeBytes > 0
                ? ` · ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`
                : ''}
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-[11px] text-[color:var(--danger-text)]">{error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {data.state === 'draft' ? (
          <>
            <button
              className="admin-button admin-button-primary"
              data-testid="gmail-draft-send"
              disabled={busy}
              onClick={onSend}
              type="button"
            >
              Send
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-danger"
              disabled={busy}
              onClick={onDiscard}
              type="button"
            >
              Discard
            </button>
          </>
        ) : null}

        {data.state === 'sending' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="admin-button admin-button-secondary"
              data-testid="gmail-draft-undo"
              disabled={busy}
              onClick={onUndo}
              type="button"
            >
              Undo
            </button>
            {/* No countdown digits: a ticking number is the anxiety pattern,
                and Gmail's own undo shows none. */}
            <span className="text-[11px] text-[color:var(--tx3)]">
              Sending shortly — you can still stop it.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The data-wired card the message row renders. */
export const GmailDraftCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const card = readGmailDraftCard(metadata)
  const draft = useGmailDraft(card?.draftActionId ?? null)
  const send = useSendGmailDraft()
  const undo = useUndoGmailSend()
  const discard = useDiscardGmailDraft()
  const [error, setError] = useState<string | null>(null)

  if (!card) return null

  // A viewer who is not the mailbox owner gets a 404 by design — render
  // nothing rather than an empty shell advertising a draft they cannot see.
  // Any OTHER failure is the owner's own network or server problem and must
  // not be disguised as absence.
  if (draft.isError) {
    const status = (draft.error as { status?: number } | null)?.status
    if (status === 404 || status === undefined) return null
    return (
      <div className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 text-xs text-[color:var(--tx3)]">
        Couldn’t load this draft.{' '}
        <button
          className="font-semibold text-[color:var(--accent)]"
          onClick={() => void draft.refetch()}
          type="button"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!draft.data) {
    return (
      <div className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 text-xs text-[color:var(--tx3)]">
        Loading draft…
      </div>
    )
  }

  const data = draft.data
  const act = async (run: () => Promise<unknown>, message: string) => {
    setError(null)
    try {
      await run()
    } catch {
      setError(message)
    }
  }

  return (
    <GmailDraftCardView
      busy={send.isPending || undo.isPending || discard.isPending}
      data={data}
      error={error}
      onDiscard={() =>
        void act(
          () => discard.mutateAsync(card.draftActionId),
          'Could not discard the draft.',
        )
      }
      onSend={() =>
        void act(
          () =>
            send.mutateAsync({
              id: card.draftActionId,
              // Send back exactly what this card rendered, so a draft that
              // changed since is refused rather than delivered.
              expectedFingerprint: data.contentFingerprint,
            }),
          'Could not send. The draft may have changed — reload and check it.',
        )
      }
      onUndo={() =>
        void act(
          () => undo.mutateAsync(card.draftActionId),
          'Too late to undo — the email has gone.',
        )
      }
    />
  )
}
