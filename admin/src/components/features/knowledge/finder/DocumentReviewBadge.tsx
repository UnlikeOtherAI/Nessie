import type { MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DocumentReviewRecord } from '@nessie/schemas'

import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { Pill } from '../../../primitives/Pill'
import { AgentDraftBadge } from '../AgentDraftBadge'
import { isAgentDraft } from '../page-status'

/**
 * The row badge on a page a document trigger sent to its agent — *"Sent to
 * CTO for review · v5"*, then *"Reviewed by CTO · v5"* once that review ran —
 * in the Finder's columns and list, and so in a project's Docs tab
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Finder and
 * project docs"). It answers "has the agent seen my edit?" at the row the
 * person just saved.
 *
 * It leads to the thread the review happened in, only when the Finder read
 * says the viewer may open it. The badge sits inside the row, which is itself
 * the row's one control (a `role="option"` button), so the way in cannot be a
 * nested link: a pointer opens the thread from the badge, and the keyboard and
 * a screen reader reach the same thread through the row's menu, "Open review
 * thread". Without a thread it is text.
 */

/** Where the admin opens a channel thread; the ticket work chip goes the same way. */
export const reviewThreadPath = (thread: { channelId: string; id: string }): string =>
  `/channels/${encodeURIComponent(thread.channelId)}/threads/${encodeURIComponent(thread.id)}`

/**
 * "Sent to CTO for review · v5" until a run that took the change in has
 * finished, "Reviewed by CTO · v5" after: the badge never claims a review
 * that has not happened yet.
 */
export const documentReviewLabel = (review: Pick<DocumentReviewRecord, 'agent' | 'state' | 'versionNumber'>): string =>
  review.state === 'reviewed'
    ? `Reviewed by ${review.agent.name} · v${review.versionNumber}`
    : `Sent to ${review.agent.name} for review · v${review.versionNumber}`

const reviewedOn = (value: string): string =>
  new Date(value).toLocaleString([], { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' })

export const DocumentReviewBadge = ({ review }: { review: DocumentReviewRecord }) => {
  const navigate = useNavigate()
  const thread = review.thread
  const when = review.state === 'reviewed'
    ? `${review.agent.name} reviewed version ${review.versionNumber}, sent on ${reviewedOn(review.sentAt)}`
    : `Version ${review.versionNumber} was sent to ${review.agent.name} on ${reviewedOn(review.sentAt)}; `
      + 'not reviewed yet'
  const open = (event: MouseEvent<HTMLElement>) => {
    // The row beneath would select and open the document on the same click.
    event.stopPropagation()
    if (thread) void navigate(reviewThreadPath(thread))
  }
  return (
    <span
      className={thread ? 'shrink-0 cursor-pointer hover:underline' : 'shrink-0'}
      data-review-thread={thread?.id}
      data-testid="document-review-badge"
      onClick={thread ? open : undefined}
      title={thread ? `${when}. Open the review thread.` : `${when}.`}
    >
      <Pill radius="chip" size="sm" tone="info" uppercase={false}>{documentReviewLabel(review)}</Pill>
    </span>
  )
}

/**
 * A page row's badges, in the columns and in the list alike: an agent draft
 * waiting for a person, and the newest review of it.
 */
export const finderRowBadges = (
  page: KnowledgePageRecord,
  review: DocumentReviewRecord | undefined,
): ReactNode => (isAgentDraft(page) || review ? (
  <>
    {isAgentDraft(page) ? <AgentDraftBadge /> : null}
    {review ? <DocumentReviewBadge review={review} /> : null}
  </>
) : undefined)
