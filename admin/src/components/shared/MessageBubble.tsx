type MessageBubbleProps = {
  content: string
  role: 'assistant' | 'system' | 'user'
  streaming?: boolean
  timestamp?: string
}

const roleTone = {
  assistant: 'border-[color:var(--accent)]/20 bg-[color:var(--accent-soft)]',
  system: 'border-[color:var(--warning)]/25 bg-[color:var(--warning)]/10',
  user: 'border-[color:var(--line)] bg-white/75',
} as const

export const MessageBubble = ({
  content,
  role,
  streaming = false,
  timestamp,
}: MessageBubbleProps) => (
  <article className={`rounded-[1.5rem] border p-4 ${roleTone[role]}`}>
    <div
      className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]"
    >
      <span>{streaming ? `${role} streaming` : role}</span>
      {timestamp ? <span>{new Date(timestamp).toLocaleString()}</span> : null}
    </div>
    <p className="mt-3 whitespace-pre-wrap text-sm leading-6">
      {content}
      {streaming ? (
        <span className="ml-1 inline-flex h-2 w-2 rounded-full bg-[color:var(--thinking)] status-pulse" />
      ) : null}
    </p>
  </article>
)
