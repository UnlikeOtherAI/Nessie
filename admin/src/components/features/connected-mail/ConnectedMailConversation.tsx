import type { ConnectedMailConversation, ConnectedMailMessage } from '@nessie/schemas'

import { EmailMessageBody } from '../mailbox/EmailMessageBody'

type ConnectedMailConversationProps = {
  conversation: ConnectedMailConversation
  onReply: (message: ConnectedMailMessage) => void
}

/** Live-provider conversation reader. Bodies are sanitized by the server and
 * retain the existing remote-content reveal affordance rather than a second
 * HTML rendering path. */
export const ConnectedMailConversationView = ({
  conversation,
  onReply,
}: ConnectedMailConversationProps) => (
  <section aria-label="Conversation" className="flex min-h-0 flex-col overflow-y-auto" data-testid="connected-mail-conversation">
    {conversation.earlierMessagesMayExist ? (
      <p className="mb-3 text-xs text-[color:var(--tx3)]">Earlier messages may be available from this provider.</p>
    ) : null}
    <ol className="flex flex-col gap-4">
      {conversation.messages.map((message) => (
        <li className="border-b border-[var(--sep)] pb-4 last:border-b-0" key={message.id}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-[color:var(--tx)]">{message.from ?? 'Unknown sender'}</span>
            <span className="text-xs text-[color:var(--tx3)]">to {message.to.join(', ') || 'you'}</span>
            {message.cc.length > 0 ? <span className="text-xs text-[color:var(--tx3)]">cc {message.cc.join(', ')}</span> : null}
            {message.receivedAt ? <span className="ml-auto text-xs text-[color:var(--tx3)]">{new Date(message.receivedAt).toLocaleString()}</span> : null}
          </div>
          <EmailMessageBody message={message} />
          {message.attachments.length > 0 ? (
            <p className="mt-2 text-xs text-[color:var(--tx3)]">
              {message.attachments.map((attachment) => attachment.filename).join(', ')}
            </p>
          ) : null}
          <button className="mt-3 text-xs font-semibold text-[color:var(--accent)]" onClick={() => onReply(message)} type="button">
            Reply
          </button>
        </li>
      ))}
    </ol>
  </section>
)
