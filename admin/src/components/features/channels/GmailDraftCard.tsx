import { useState } from 'react'
import { Pill } from '../../primitives/Pill'
import { useGmailDraft, type GmailDraftView } from '../../../facades/gmail/hooks'

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
 * This is a read-only compatibility view for historical message metadata.
 * The shared Mail doorway is the only place a person can edit, send, discard,
 * or undo a connected-mail draft.
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
}: {
  data: GmailDraftView
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

  return <GmailDraftCardView data={draft.data} />
}
