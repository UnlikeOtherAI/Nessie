import type { ReactNode } from 'react'
import type { EmailConversationRecord } from '@nessie/schemas'

import type { NavigationLayout } from '../../../navigation/layout'

type MailboxWorkspaceProps = {
  conversation: ReactNode
  conversationList: ReactNode
  /** The shell owns this decision; the workspace never reads breakpoints itself. */
  layout: NavigationLayout
}

export type MailboxThreadSummary = Pick<
  EmailConversationRecord,
  | 'awaitingApproval'
  | 'hasBounce'
  | 'id'
  | 'lastMessageAt'
  | 'messageCount'
  | 'participants'
  | 'snippet'
  | 'subject'
> & {
  /** Connected providers can expose this without changing the row renderer. */
  hasAttachments?: boolean
  /** A word as well as emphasis makes the state survive forced colours. */
  unread?: boolean
}

type MailboxThreadListProps = {
  ariaLabel?: string
  onSelect: (threadId: string) => void
  selectedId?: string
  threads: readonly MailboxThreadSummary[]
}

const dateLabel = (value: string): string => new Date(value).toLocaleDateString()

/**
 * A fixed-height mail surface with exactly two scroll owners. It deliberately
 * receives slots rather than fetching: hosted and connected mail use the same
 * renderer while retaining their own entitlement-scoped facades.
 */
export const MailboxWorkspace = ({
  conversation,
  conversationList,
  layout,
}: MailboxWorkspaceProps) => (
  <div
    className={[
      'grid min-h-0 min-w-0 flex-1 gap-4 px-[var(--page-gutter)] pb-6',
      layout === 'single'
        ? 'grid-rows-[minmax(11rem,2fr)_minmax(0,3fr)]'
        // The reader owns the majority of a split viewport. A fixed 16rem
        // list made email bodies unusably narrow beside the app rail at tablet
        // widths; this remains one shared layout decision for both mail homes.
        : 'grid-cols-[minmax(13rem,30%)_minmax(0,1fr)]',
    ].join(' ')}
    data-layout={layout}
    data-testid="mailbox-workspace"
  >
    {conversationList}
    {conversation}
  </div>
)

/**
 * The listbox is one selectable mailbox thread list, not a row of lookalike
 * buttons. Roving tab stops and arrows make selection usable without a mouse.
 */
export const MailboxThreadList = ({
  ariaLabel = 'Conversations',
  onSelect,
  selectedId,
  threads,
}: MailboxThreadListProps) => {
  const moveSelection = (threadId: string, direction: -1 | 1): void => {
    const current = threads.findIndex((thread) => thread.id === threadId)
    const next = threads[current + direction]
    if (!next) return
    onSelect(next.id)
    requestAnimationFrame(() => document.getElementById(`mailbox-thread-${next.id}`)?.focus())
  }

  return (
    <div aria-label={ariaLabel} className="min-h-0 overflow-y-auto" role="listbox">
      {threads.map((thread, index) => {
        const selected = thread.id === selectedId
        // A listbox has one roving tab stop even before a route selects a
        // thread. Otherwise keyboard users cannot enter a fresh mailbox.
        const tabStop = selected || (!selectedId && index === 0)
        return (
          <button
            aria-selected={selected}
            className={[
              'w-full border-b border-[var(--sep)] px-3 py-3 text-left',
              selected ? 'bg-[var(--panel-soft)]' : 'hover:bg-[var(--panel-soft)]',
            ].join(' ')}
            id={`mailbox-thread-${thread.id}`}
            key={thread.id}
            onClick={() => onSelect(thread.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveSelection(thread.id, 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveSelection(thread.id, -1)
              }
            }}
            role="option"
            tabIndex={tabStop ? 0 : -1}
            type="button"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-[color:var(--tx)]">
                {thread.subject || '(no subject)'}
              </span>
              <span className="shrink-0 text-xs text-[color:var(--tx3)]">
                {dateLabel(thread.lastMessageAt)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
              {thread.participants.join(', ')}
            </span>
            <span className="mt-1 block truncate text-xs text-[color:var(--tx2)]">
              {thread.snippet}
            </span>
            <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-xs text-[color:var(--tx3)]">
              {thread.unread ? <span className="font-semibold text-[color:var(--tx)]">Unread</span> : null}
              {thread.messageCount > 0 ? <span>{thread.messageCount} messages</span> : null}
              {thread.hasAttachments ? <span>Has attachments</span> : null}
              {thread.awaitingApproval ? <MailboxThreadStatus tone="warning">Awaiting approval</MailboxThreadStatus> : null}
              {thread.hasBounce ? <MailboxThreadStatus tone="danger">Delivery problem</MailboxThreadStatus> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

const MailboxThreadStatus = ({ children, tone }: { children: ReactNode; tone: 'danger' | 'warning' }) => (
  <span
    className={[
      'rounded-full border px-2 py-0.5 text-[11px]',
      tone === 'warning'
        ? 'border-[var(--warning-border)] bg-[var(--warning-soft)] text-[color:var(--warning-text)]'
        : 'border-[var(--danger-border)] bg-[var(--danger-soft)] text-[color:var(--danger-text)]',
    ].join(' ')}
  >
    {children}
  </span>
)
