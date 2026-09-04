export type GmailSendOutcome = {
  id: string
  kind: 'queued' | 'checking' | 'restoring' | 'delivery_unknown' | 'update_unknown' | 'sent'
  isDispatching?: boolean
}

type GmailSendOutcomePanelProps = {
  onBackToMail: () => void
  onStartNewEmail: () => void
  onUndo: () => void
  outcome: GmailSendOutcome
  undoPending: boolean
}

/** A recovered Gmail action is an outcome, never an editable resend form. */
export const GmailSendOutcomePanel = ({
  onBackToMail, onStartNewEmail, onUndo, outcome, undoPending,
}: GmailSendOutcomePanelProps) => (
  <section className="px-[var(--page-gutter)] py-6" data-testid="connected-mail-sent">
    <p aria-live="polite" className="text-sm text-[color:var(--tx)]">
      {outcome.kind === 'queued' ? 'Your email is queued to send.'
        : outcome.kind === 'checking' ? outcome.isDispatching ? 'Your email is being delivered. It will not be sent again.' : 'Your email is being checked before delivery. It will not be sent again.'
            : outcome.kind === 'restoring' ? 'Your draft is being restored. It will be available shortly.'
              : outcome.kind === 'delivery_unknown' ? 'Delivery is unconfirmed. Check the provider’s Sent mail; this action will not be resent.'
                : outcome.kind === 'update_unknown' ? 'This draft update could not be confirmed. Open Gmail to inspect it; it will not be sent again.'
                  : 'Your email was sent.'}
    </p>
    {outcome.kind === 'queued' && outcome.id ? <button className="mt-3 admin-button admin-button-secondary" disabled={undoPending} onClick={onUndo} type="button">Undo send</button> : null}
    {outcome.kind === 'delivery_unknown' ? <button className="mt-3 admin-button admin-button-secondary" onClick={onStartNewEmail} type="button">I checked Sent — start a new email</button> : null}
    {outcome.kind === 'update_unknown' ? <button className="mt-3 admin-button admin-button-secondary" onClick={onStartNewEmail} type="button">I checked Gmail — start a new email</button> : null}
    <button className="ml-2 mt-3 admin-button admin-button-primary" onClick={onBackToMail} type="button">Back to mail</button>
  </section>
)
