type GmailAttachment = { filename: string; mimeType: string; sizeBytes: number }

type GmailUnsupportedDraftPanelProps = {
  attachments: GmailAttachment[]
  reason: 'attachments' | 'non_plain_content' | null
}

/** Provider formats we cannot preserve remain provider-owned rather than flattened. */
export const GmailUnsupportedDraftPanel = ({ attachments, reason }: GmailUnsupportedDraftPanelProps) => (
  <section className="px-[var(--page-gutter)] py-6" data-testid="gmail-unsupported-draft">
    <p aria-live="polite" className="text-sm text-[color:var(--tx)]">
      {reason === 'attachments'
        ? 'This Gmail draft has attachments, so it must be sent from Gmail to preserve them.'
        : 'This Gmail draft has content Nessie cannot safely edit. Send it from Gmail to preserve it.'}
    </p>
    {attachments.length > 0 ? <ul className="mt-3 text-sm text-[color:var(--tx2)]">
      {attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`}>{attachment.filename}</li>)}
    </ul> : null}
    <a className="mt-3 inline-flex font-semibold text-[color:var(--accent)]" href="https://mail.google.com/mail/u/0/#drafts" rel="noreferrer" target="_blank">Open Gmail to send this draft</a>
  </section>
)
