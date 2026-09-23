import type { KeyboardEvent } from 'react'
import type { DeepWaterBriefMessageView, DeepWaterBriefView } from '@nessie/schemas'
import { DeepWaterBriefMessageSchema } from '@nessie/schemas'
import { useActorNames } from '../../shared/ActorName'
import { Textarea } from '../../shared/FormControls'
import { MessageMarkdown } from '../channels/MessageMarkdown'
import { BriefOpenQuestions } from './BriefOpenQuestions'
import { useElapsed } from './useElapsed'

/**
 * The conversation with DeepWater's research planner (overview §1 goal 2). The
 * planner's reply arrives whole — there is no token streaming in this release
 * (amendments-fable F8) — so while it works the dialog says so, with how long
 * it has been at it. A planner that could not answer says why, and a person
 * can send the words it failed on again (`sendAgainMessage`); its open
 * questions offer one-tap answers.
 */

const plainText = (text: string) => text

const MessageRow = ({
  message,
  meUserId,
  plannerName,
  resolveName,
}: {
  message: DeepWaterBriefMessageView
  meUserId: string
  plannerName: string
  resolveName: (kind: 'user' | 'agent', id: string) => string
}) => {
  if (message.author.kind === 'event') {
    return <p className="text-center text-xs italic text-[color:var(--tx3)]">{message.content}</p>
  }
  const fromPlanner = message.author.kind === 'planner'
  const author = message.author.kind === 'planner'
    ? plannerName
    : message.author.kind === 'person'
      ? message.author.userId === meUserId ? 'You' : resolveName('user', message.author.userId)
      : resolveName('agent', message.author.agentId)
  return (
    <div
      className={[
        'flex flex-col gap-1 rounded-[var(--radius-md)] px-3 py-2 text-sm',
        fromPlanner ? 'bg-[color:var(--overlay-weak)]' : 'bg-[color:var(--accent-soft)]',
      ].join(' ')}
      data-author={message.author.kind}
    >
      <span className="text-xs font-semibold text-[color:var(--tx2)]">{author}</span>
      {message.author.kind === 'person' ? (
        <p className="whitespace-pre-wrap text-[color:var(--tx)]">{message.content}</p>
      ) : (
        <div className="text-[color:var(--tx)]">
          <MessageMarkdown allowRemoteImages={false} renderInlineText={plainText}>
            {message.content}
          </MessageMarkdown>
        </div>
      )}
    </div>
  )
}

export type BriefConversationProps = {
  brief: DeepWaterBriefView
  /** The person may type (their own drafting brief), even while the planner works. */
  canCompose: boolean
  /** The server accepts a reply now. */
  canSend: boolean
  error: string | null
  meUserId: string
  message: string
  onMessageChange: (message: string) => void
  onSend: (message: string) => void
  /** The words Send again sends after the planner could not answer; null when they are not known. */
  sendAgain: string | null
  sending: boolean
}

export const BriefConversation = ({
  brief,
  canCompose,
  canSend,
  error,
  meUserId,
  message,
  onMessageChange,
  onSend,
  sendAgain,
  sending,
}: BriefConversationProps) => {
  const resolveActor = useActorNames()
  const resolveName = (kind: 'user' | 'agent', id: string) => resolveActor(kind, id).name
  const turn = brief.plannerTurn
  const elapsed = useElapsed(turn.status === 'replying' ? turn.since : null)
  const replying = turn.status === 'replying'
  const ready = canSend && !replying && !sending
  const valid = DeepWaterBriefMessageSchema.safeParse(message).success

  const send = (text: string) => {
    if (ready && DeepWaterBriefMessageSchema.safeParse(text).success) onSend(text.trim())
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send(message)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="research-brief-conversation">
      <div aria-live="polite" className="flex max-h-[22rem] min-h-[8rem] flex-col gap-2 overflow-y-auto pr-1">
        {brief.messages.length === 0 && !replying ? (
          <p className="text-sm text-[color:var(--tx3)]">
            {brief.planner.displayName} will reply here with questions and a first draft of the brief.
          </p>
        ) : null}
        {brief.messages.map((entry) => (
          <MessageRow
            key={entry.id}
            message={entry}
            meUserId={meUserId}
            plannerName={brief.planner.displayName}
            resolveName={resolveName}
          />
        ))}
        {replying ? (
          <p className="text-sm text-[color:var(--tx2)]" data-testid="research-brief-replying">
            {brief.planner.displayName} is replying…
            {elapsed ? <span className="ml-1 tabular-nums text-[color:var(--tx3)]">{elapsed}</span> : null}
          </p>
        ) : null}
      </div>

      {turn.status === 'failed' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--danger-text)]" role="alert">
          <span>{turn.message}</span>
          {turn.retryable && canCompose && sendAgain !== null ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={!ready}
              onClick={() => send(sendAgain)}
              type="button"
            >
              Send again
            </button>
          ) : null}
          {turn.retryable && canCompose && sendAgain === null ? (
            <span className="text-[color:var(--tx2)]">Write your reply again below to send it.</span>
          ) : null}
        </div>
      ) : null}
      {/* A cancel that did not go through is said beside Cancel (`cancelFailure`), not here. */}
      {brief.pendingAction?.error && brief.pendingAction.kind !== 'cancel' ? (
        <p className="text-sm text-[color:var(--danger-text)]" role="alert">{brief.pendingAction.error.message}</p>
      ) : null}

      <BriefOpenQuestions canAnswer={canCompose && ready} onAnswer={send} questions={brief.openQuestions} />

      {canCompose ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={`Reply to ${brief.planner.displayName}`}
            className="min-h-20"
            maxLength={20_000}
            onChange={(event) => onMessageChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Answer the questions, or say what to change."
            value={message}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[color:var(--tx3)]">
              {replying ? `You can send this once ${brief.planner.displayName} has replied.` : null}
            </span>
            <button
              className="admin-button admin-button-secondary"
              disabled={!ready || !valid}
              onClick={() => send(message)}
              type="button"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
