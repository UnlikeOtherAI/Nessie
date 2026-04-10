import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage } from '../../../../facades/designer/hooks'

type DesignerChatProps = {
  error: string | null
  messages: ChatMessage[]
  onSend: (message: string) => void
  onStop: () => void
  status: string | null
  streaming: boolean
  thinking: boolean
}

const ThinkingIndicator = ({ status }: { status: string | null }) => (
  <div
    className={[
      'mr-auto max-w-[90%] rounded-xl border border-[color:var(--sep)]',
      'bg-[color:var(--panel)] px-3 py-2 text-sm text-[color:var(--tx)]',
    ].join(' ')}
  >
    <div className="flex items-center gap-2">
      <div className="thinking-dots">
        <span />
        <span />
        <span />
      </div>
      {status && (
        <span className="text-xs text-[color:var(--tx3)]">{status}</span>
      )}
    </div>
  </div>
)

export const DesignerChat = ({
  error,
  messages,
  onSend,
  onStop,
  status,
  streaming,
  thinking,
}: DesignerChatProps) => {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, thinking])

  useEffect(() => {
    if (!streaming) {
      inputRef.current?.focus()
    }
  }, [streaming])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim() || streaming) return
    onSend(input)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
        <svg
          className="h-4 w-4 text-[color:var(--accent)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-sm font-semibold text-white">Design Assistant</span>
        {streaming && <span className="streaming-dot" />}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        <div className="grid gap-3">
          <div
            className={[
              'mr-auto max-w-[90%] rounded-xl border border-[color:var(--sep)]',
              'bg-[color:var(--panel)] px-3 py-2 text-sm text-[color:var(--tx)]',
            ].join(' ')}
          >
            <div className="whitespace-pre-wrap">
              {[
                "Hi! I can control anything on this form — name, role, system prompt, tools, and more.",
                "Tell me what you want to build and I'll configure the agent for you.",
              ].join('\n\n')}
            </div>
          </div>
          {messages
            .filter((msg) => msg.content.trim() !== '')
            .map((msg, i, arr) => (
              <div
                className={[
                  'max-w-[90%] rounded-xl px-3 py-2 text-sm',
                  msg.role === 'user'
                    ? 'ml-auto bg-[color:var(--accent)] text-white'
                    : [
                        'mr-auto border border-[color:var(--sep)]',
                        'bg-[color:var(--panel)] text-[color:var(--tx)]',
                      ].join(' '),
                ].join(' ')}
                key={i}
              >
                <div className="whitespace-pre-wrap">
                  {msg.content}
                  {streaming &&
                    i === arr.length - 1 &&
                    msg.role === 'assistant' && <span className="streaming-dot" />}
                </div>
              </div>
            ))}
          {thinking && <ThinkingIndicator status={status} />}
        </div>

        {error && (
          <div
            className={[
              'mt-2 rounded-lg border border-[color:var(--danger)]/30',
              'bg-[color:var(--danger)]/10 px-3 py-2 text-xs text-[color:var(--danger)]',
            ].join(' ')}
          >
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[color:var(--sep)] p-3">
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            autoComplete="off"
            className={[
              'admin-input flex-1 resize-none text-sm',
              'min-h-[40px] max-h-[120px]',
            ].join(' ')}
            disabled={streaming}
            onKeyDown={handleKeyDown}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe your agent..."
            rows={1}
            value={input}
          />
          {streaming ? (
            <button
              className="admin-button admin-button-secondary flex-shrink-0"
              onClick={onStop}
              type="button"
            >
              Stop
            </button>
          ) : (
            <button
              className="admin-button admin-button-primary flex-shrink-0"
              disabled={!input.trim()}
              type="submit"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
