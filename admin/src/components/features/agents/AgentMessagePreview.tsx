import type { AgentMessage } from '@nessie/schemas'
import { EmptyState } from '../../shared/EmptyState'

type AgentMessagePreviewProps = {
  messages: AgentMessage[]
}

const compactPreview = (value: string, maxLength = 180): string => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`
}

export const AgentMessagePreview = ({ messages }: AgentMessagePreviewProps) => (
  <section className="grid gap-3">
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
            {compactPreview(message.contentPreview)}
          </div>
        </article>
      ))
    )}
  </section>
)
