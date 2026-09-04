import type { EmailDraftPreview } from '@nessie/schemas'

const RecipientLine = ({ label, recipients }: { label: string; recipients: string[] }) => {
  if (recipients.length === 0) return null
  return (
    <div>
      <dt className="font-semibold text-[color:var(--tx3)]">{label}</dt>
      <dd className="break-all text-[color:var(--tx)]">{recipients.join(', ')}</dd>
    </div>
  )
}

/** The complete, frozen connected-mail message that an approver will authorize. */
export const MailboxSendApprovalPreview = ({ draft }: { draft: EmailDraftPreview }) => (
  <section
    className="mt-3 rounded border border-[color:var(--warning-border)] bg-[color:var(--panel)] p-3 text-xs"
    data-testid="mailbox-send-approval-preview"
  >
    <p className="font-semibold text-[color:var(--tx)]">Email to send</p>
    <dl className="mt-2 grid gap-1 leading-5">
      <div>
        <dt className="font-semibold text-[color:var(--tx3)]">From</dt>
        <dd className="break-all text-[color:var(--tx)]">{draft.mailboxAddress}</dd>
      </div>
      <RecipientLine label="To" recipients={draft.to} />
      <RecipientLine label="Cc" recipients={draft.cc} />
      <RecipientLine label="Bcc" recipients={draft.bcc} />
      <div>
        <dt className="font-semibold text-[color:var(--tx3)]">Subject</dt>
        <dd className="whitespace-pre-wrap text-[color:var(--tx)]">{draft.subject}</dd>
      </div>
    </dl>
    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-2 text-[11px] leading-4 text-[color:var(--tx2)]">
      {draft.text}
    </pre>
    {draft.externalDisclosureSources.length > 0 ? (
      <p className="mt-2 leading-4 text-[color:var(--tx3)]">
        This reply also used material the mailbox owner cannot access:{' '}
        {draft.externalDisclosureSources.join(', ')}.
      </p>
    ) : null}
  </section>
)
