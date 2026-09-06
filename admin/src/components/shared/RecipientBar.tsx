import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import type { AgentRecord, UserRecord } from '../../lib/api-client'
import {
  buildRecipientOptions,
  recipientKey,
  type Recipient,
  type RecipientOption,
} from '../../lib/channel-compose-recipients'
import { AgentVisibilityPill } from '../features/agents/AgentVisibilityPill'
import { UserAvatar } from '../primitives/UserAvatar'
import { AgentAvatar } from '../shared/AgentAvatar'

type RecipientBarProps = {
  /** Agents offered by the autocomplete. Already filtered to what may be addressed. */
  agents: AgentRecord[]
  users: UserRecord[]
  recipients: Recipient[]
  onChange: (recipients: Recipient[]) => void
  token: string | null
  /** The word before the chips — "To" when composing, "Tell" on a board. */
  label: string
  placeholder: string
  /** Focused on mount. The compose screen wants it; a settings section does not. */
  autoFocus?: boolean
  disabled?: boolean
  /**
   * The caller's handle on the text field. Passed rather than owned because the
   * compose screen focuses it on events this component knows nothing about —
   * switching between people and agents, returning from the agent designer.
   */
  inputRef?: RefObject<HTMLInputElement | null>
}

const nameOf = (
  recipient: Recipient,
  usersById: Map<string, UserRecord>,
  agentsById: Map<string, AgentRecord>,
): string =>
  recipient.kind === 'user'
    ? usersById.get(recipient.id)?.displayName ?? 'Unknown user'
    : agentsById.get(recipient.id)?.name ?? 'Unknown agent'

/**
 * Choosing people and agents, as chips with an autocomplete beneath.
 *
 * Extracted verbatim out of the New-message screen when a board needed the same
 * control: two of these would be the fork Rule zero §4 names, and the choosing
 * is identical even though what happens next is not — one starts a
 * conversation, the other decides who hears that a ticket moved. The model it
 * renders (`channel-compose-recipients.ts`) was already shared; only the
 * drawing of it was trapped inside a page.
 */
export const RecipientBar = ({
  agents,
  users,
  recipients,
  onChange,
  token,
  label,
  placeholder,
  autoFocus = false,
  disabled = false,
  inputRef: callerRef,
}: RecipientBarProps) => {
  const ownRef = useRef<HTMLInputElement>(null)
  const inputRef = callerRef ?? ownRef
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  )
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const selectedKeys = useMemo(
    () => new Set(recipients.map(recipientKey)),
    [recipients],
  )
  const options = useMemo<RecipientOption[]>(
    () => buildRecipientOptions({ agents, limit: 8, query, selectedKeys, users }),
    [agents, query, selectedKeys, users],
  )

  const add = useCallback(
    (option: RecipientOption) => {
      onChange([...recipients, { id: option.id, kind: option.kind }])
      setQuery('')
      setHighlightedIndex(0)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    },
    [onChange, recipients],
  )

  const remove = useCallback(
    (recipient: Recipient) => {
      onChange(recipients.filter((item) => recipientKey(item) !== recipientKey(recipient)))
    },
    [onChange, recipients],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, options.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter' && options.length > 0) {
      event.preventDefault()
      const option = options[highlightedIndex] ?? options[0]
      if (option) add(option)
      return
    }
    // Backspace on an empty field takes the last chip back, which is what every
    // address bar a person has used does.
    if (event.key === 'Backspace' && query === '' && recipients.length > 0) {
      event.preventDefault()
      const last = recipients[recipients.length - 1]
      if (last) remove(last)
    }
  }

  const showOptions = focused && options.length > 0 && !disabled

  return (
    <div className="relative rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
      <div className="flex min-h-[38px] items-center gap-2">
        <span className="flex-shrink-0 text-sm font-semibold text-[color:var(--tx2)]">
          {label}
        </span>
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          onClick={() => {
            if (disabled) return
            setFocused(true)
            inputRef.current?.focus()
          }}
          role="presentation"
        >
          {recipients.map((recipient) => {
            const agent = recipient.kind === 'agent'
              ? agentsById.get(recipient.id)
              : undefined
            const name = nameOf(recipient, usersById, agentsById)
            return (
              <span
                key={recipientKey(recipient)}
                className={[
                  'flex max-w-full items-center gap-1 rounded-md',
                  'bg-[color:var(--overlay)] px-2 py-1 text-sm text-[color:var(--tx)]',
                ].join(' ')}
              >
                <span className="truncate">{name}</span>
                {agent ? <AgentVisibilityPill visibility={agent.visibility} /> : null}
                <button
                  aria-label={`Remove ${name}`}
                  className="flex h-4 w-4 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]"
                  disabled={disabled}
                  onClick={() => remove(recipient)}
                  type="button"
                >
                  ×
                </button>
              </span>
            )
          })}
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            className="min-w-[160px] flex-1 bg-transparent text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
            disabled={disabled}
            onBlur={() => window.setTimeout(() => {
              if (document.activeElement !== inputRef.current) setFocused(false)
            }, 120)}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlightedIndex(0)
            }}
            onFocus={() => setFocused(true)}
            onKeyDown={onKeyDown}
            placeholder={recipients.length === 0 ? placeholder : ''}
            value={query}
          />
        </div>
      </div>

      {showOptions ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] max-h-72 overflow-y-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] py-1 shadow-xl"
          style={{ zIndex: 'var(--layer-popover)' }}
        >
          {options.map((option, index) => (
            <button
              key={recipientKey(option)}
              className={[
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                index === highlightedIndex
                  ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                  : 'text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]',
              ].join(' ')}
              onMouseDown={(event) => {
                event.preventDefault()
                add(option)
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
              type="button"
            >
              {option.kind === 'user' && option.user ? (
                <UserAvatar
                  avatarAttachmentId={option.user.avatarAttachmentId ?? undefined}
                  avatarUrl={option.user.avatarUrl ?? undefined}
                  displayName={option.user.displayName}
                  size={24}
                  token={token}
                  userId={option.user.id}
                />
              ) : (
                <AgentAvatar agentId={option.id} size={24} token={token} />
              )}
              <span className="min-w-0 flex flex-col">
                <span className="truncate">{option.label}</span>
                <span className="truncate text-xs opacity-60">{option.detail}</span>
              </span>
              <span className="ml-auto flex-shrink-0">
                {option.kind === 'agent' && option.agentVisibility ? (
                  <AgentVisibilityPill visibility={option.agentVisibility} />
                ) : (
                  <span className="text-xs opacity-60">{option.category}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
