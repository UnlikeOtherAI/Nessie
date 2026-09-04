import type { EmailMessageRecord } from '@nessie/schemas'

import { EmailMessageBody } from './EmailMessageBody'
import type { MailboxThreadSummary } from './MailboxWorkspace'

type MailConversationProps = {
  messages: readonly EmailMessageRecord[]
  thread?: Pick<MailboxThreadSummary, 'subject'>
}

/** The thread reader is data-only so every entitled mail source shares it. */
export const MailConversation = ({ messages, thread }: MailConversationProps) => (
  <section
    aria-label={thread?.subject ? `Conversation: ${thread.subject}` : 'Conversation'}
    className="flex min-h-0 flex-col overflow-y-auto"
    data-testid="mailbox-reading-pane"
  >
    {thread ? <h2 className="mb-3 text-lg font-semibold text-[color:var(--tx)]">{thread.subject}</h2> : null}
    <ol className="flex flex-col gap-4">
      {messages.map((message) => <MailMessage key={message.id} message={message} />)}
    </ol>
  </section>
)

export const MailMessage = ({ message }: { message: EmailMessageRecord }) => (
  <li className="border-b border-[var(--sep)] pb-4 last:border-b-0">
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="font-medium text-[color:var(--tx)]">
        {message.direction === 'inbound'
          ? message.fromName ?? message.fromAddress
          : `You (${message.fromAddress})`}
      </span>
      <span className="text-xs text-[color:var(--tx3)]">to {message.toAddresses.join(', ')}</span>
      <span className="ml-auto text-xs text-[color:var(--tx3)]">
        {new Date(message.occurredAt).toLocaleString()}
      </span>
    </div>
    {message.deliveryState && message.deliveryState !== 'sent' ? (
      <p className="mb-2 text-xs text-[color:var(--warning-text)]">{deliveryLabel(message.deliveryState)}</p>
    ) : null}
    <EmailMessageBody message={message} />
    {message.attachments.length > 0 ? (
      <ul className="mt-2 flex flex-wrap gap-2">
        {message.attachments.map((attachment) => (
          <li
            className="rounded-md border border-[var(--sep)] px-2 py-1 text-xs text-[color:var(--tx2)]"
            key={attachment.id}
          >
            {attachment.filename}
          </li>
        ))}
      </ul>
    ) : null}
  </li>
)

const deliveryLabel = (state: NonNullable<EmailMessageRecord['deliveryState']>): string => {
  switch (state) {
    case 'queued': return 'Queued to send.'
    case 'sending': return 'Sending…'
    case 'bounced': return 'This message bounced. The recipient will not receive it.'
    case 'complained': return 'The recipient reported this message as spam.'
    case 'delivery_unknown': return 'Delivery is unconfirmed — it may or may not have been sent. It was not retried.'
    default: return ''
  }
}
