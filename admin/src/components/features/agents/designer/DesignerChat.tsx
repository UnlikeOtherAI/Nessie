import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage } from '../../../../facades/designer/hooks'
import { useAgentDesignerAgent } from '../../../../facades/designer/agent-designer-identity'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { Notice } from '../../../primitives/Notice'
import type { DesignerPageContext } from './DesignerAssistantPanelContext'

type DesignerChatProps = {
  error: string | null
  /** The chat-first half of the new-agent Create / Configure choice. */
  guidedCreation?: boolean
  messages: ChatMessage[]
  /**
   * Moves this conversation into the person's own Agent Designer DM, carrying
   * the current draft. Absent where the page cannot navigate away.
   */
  onContinueInChat?: () => void
  continuingInChat?: boolean
  onSend: (message: string) => void
  onClose?: () => void
  onStop: () => void
  status: string | null
  streaming: boolean
  thinking: boolean
  pageContext?: DesignerPageContext
}

/** The panel and the DM are one specialist, so the panel says whose voice it is. */
const DEFAULT_DESIGNER_NAME = 'Agent Designer'

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
  continuingInChat,
  error,
  guidedCreation = false,
  messages,
  onContinueInChat,
  onSend,
  onClose,
  onStop,
  status,
  streaming,
  thinking,
  pageContext,
}: DesignerChatProps) => {
  const { token } = useAuthSession()
  const designer = useAgentDesignerAgent()
  const designerName = designer?.name ?? DEFAULT_DESIGNER_NAME
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
      inputRef.current?.focus({ preventScroll: true })
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
      {/* Header — the agent's own name and picture, resolved from the identity
          directory: this panel and the Agent Designer DM are one specialist. */}
      <div className="flex items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
        <AgentAvatar
          agent={designer}
          agentId={designer?.id ?? null}
          size="xs"
          token={token}
        />
        <span className="text-sm font-semibold text-[var(--tx)]">{designerName}</span>
        {streaming && <span className="streaming-dot" />}
        <div className="ml-auto flex items-center gap-1">
          {onContinueInChat ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={continuingInChat || streaming}
              onClick={onContinueInChat}
              title={`Move this into your own conversation with the ${designerName}, carrying the current draft`}
              type="button"
            >
              {continuingInChat ? 'Opening…' : 'Continue in chat'}
            </button>
          ) : null}
          {onClose ? (
            <button
              aria-label={`Close ${designerName}`}
              className="-mr-1 rounded p-1 text-[color:var(--tx3)] hover:bg-[color:var(--overlay-weak)] hover:text-[color:var(--tx)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          ) : null}
        </div>
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
              {/*
                Names the fields the assistant actually has tools for. It
                used to promise "anything on this form … and more" while
                having no way to set the model, so it announced a finished
                agent that could not be created.
              */}
              {pageContext
                ? [
                    `You’re viewing ${pageContext.title}. ${pageContext.description}`,
                    pageContext.actions.length > 0
                      ? `I can help with ${pageContext.actions.join(', ')} on this page.`
                      : 'I can explain what you’re seeing here.',
                  ].join('\n\n')
                : guidedCreation
                  ? [
                      'Tell me what you want the agent to do and I’ll build the draft for you.',
                      'I’ll set its name, role, model, instructions, and tools. You can review'
                      + ' or fine-tune everything in Configure before creating it.',
                    ].join('\n\n')
                  : [
                      'I can fill in this form for you — name, role, model,'
                      + ' system prompt and tools.',
                      'Tell me what you want the agent to do and I’ll set it up.'
                      + ' “Continue in chat” moves us into your own conversation'
                      + ' with me, carrying the draft over.',
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
                    ? 'ml-auto bg-[color:var(--accent)] text-[var(--on-accent)]'
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
          <Notice className="mt-2" radius="lg" size="sm" tone="danger">
            {error}
          </Notice>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[color:var(--sep)] p-3">
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            autoComplete="off"
            className="admin-input flex-1 resize-none min-h-[40px] max-h-[120px]"
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
