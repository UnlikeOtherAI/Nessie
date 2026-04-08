import type { AgentMessage } from '@nessie/schemas'
import { EmptyState } from '../../shared/EmptyState'

type AgentMessagePreviewProps = {
  messages: AgentMessage[]
}

export const AgentMessagePreview = ({ messages }: AgentMessagePreviewProps) => (
  <section className="grid gap-3">
    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
      Last 5 messages
    </div>
    {messages.length === 0 ? (
      <EmptyState>No recent messages for this agent yet.</EmptyState>
    ) : (
      messages.map((message) => (
        <article
          key={message.messageId}
          className="rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-4"
        >
          <div
            className={[
              'flex items-center justify-between gap-3 text-xs uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
          >
            <span>{message.role}</span>
            <span>{new Date(message.timestamp).toLocaleString()}</span>
          </div>
          <div className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            {message.contentPreview}
          </div>
        </article>
      ))
    )}
  </section>
)
