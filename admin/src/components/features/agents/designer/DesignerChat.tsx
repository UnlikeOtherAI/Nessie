import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage } from '../../../../facades/designer/hooks'

type DesignerChatProps = {
  error: string | null
  messages: ChatMessage[]
  onSend: (message: string) => void
  onStop: () => void
  streaming: boolean
}

export const DesignerChat = ({
  error,
  messages,
  onSend,
  onStop,
  streaming,
}: DesignerChatProps) => {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

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
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-2 text-2xl">&#x1F9E0;</div>
              <div className="text-sm text-[color:var(--tx3)]">
                Describe the agent you want to build.
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">
                I'll configure the name, role, system prompt, tools, and more.
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3">
          {messages.map((msg, i) => (
            <div
              className={[
                'max-w-[90%] rounded-xl px-3 py-2 text-sm',
                msg.role === 'user'
                  ? 'ml-auto bg-[color:var(--accent)] text-white'
                  : 'mr-auto border border-[color:var(--sep)] bg-[color:var(--panel)] text-[color:var(--tx)]',
              ].join(' ')}
              key={i}
            >
              <div className="whitespace-pre-wrap">
                {msg.content}
                {streaming && i === messages.length - 1 && msg.role === 'assistant' && (
                  <span className="streaming-dot" />
                )}
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-3 py-2 text-xs text-[color:var(--danger)]">
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
