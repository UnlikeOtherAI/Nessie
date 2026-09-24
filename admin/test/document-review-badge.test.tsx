import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { DocumentReviewRecord } from '@nessie/schemas'

import {
  DocumentReviewBadge,
  documentReviewLabel,
  finderRowBadges,
  reviewThreadPath,
} from '../src/components/features/knowledge/finder/DocumentReviewBadge'
import { reviewablePageIds } from '../src/facades/knowledge/document-trigger-hooks'
import {
  TicketWorkEventRow,
  ticketWorkEventOf,
} from '../src/components/features/ticket-work/TicketWorkEventRow'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks'
import type { ThreadMessageRecord } from '../src/lib/api-client'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// What the Finder and a project's Docs tab show of document triggers
// (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Finder and
// project docs"): a reviewed row says who reviewed which version, and leads
// to the review thread only for a viewer the Finder read lets open it.

const THREAD = '30000000-0000-4000-8000-000000000001'
const CHANNEL = '30000000-0000-4000-8000-000000000002'

const review = (thread: DocumentReviewRecord['thread']): DocumentReviewRecord => ({
  agent: { id: '30000000-0000-4000-8000-000000000003', name: 'CTO' },
  pageId: '30000000-0000-4000-8000-000000000004',
  reviewedAt: '2026-09-24T09:30:00.000Z',
  thread,
  triggerId: '30000000-0000-4000-8000-000000000005',
  versionNumber: 5,
})

const render = (node: React.ReactNode): string => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)

test('a reviewed row says who reviewed which version, and leads to the thread when the viewer may open it', () => {
  assert.equal(documentReviewLabel(review(null)), 'Reviewed by CTO · v5')
  assert.equal(reviewThreadPath({ channelId: CHANNEL, id: THREAD }), `/channels/${CHANNEL}/threads/${THREAD}`)

  const linked = render(<DocumentReviewBadge review={review({ channelId: CHANNEL, id: THREAD })} />)
  assert.match(linked, /Reviewed by CTO · v5/)
  assert.match(linked, new RegExp(`data-review-thread="${THREAD}"`))
  assert.match(linked, /Open the review thread\./)
  assert.match(linked, /cursor-pointer/)

  const plain = render(<DocumentReviewBadge review={review(null)} />)
  assert.match(plain, /Reviewed by CTO · v5/)
  assert.doesNotMatch(plain, /data-review-thread|Open the review thread|cursor-pointer/,
    'a viewer who may not open the thread gets the badge and no door')
  // It is never a nested link inside the row's own button.
  for (const markup of [linked, plain]) assert.doesNotMatch(markup, /<a /)
})

test('a row carries its badges only when it has something to say', () => {
  const page = (extra: Partial<KnowledgePageRecord>) => ({ kind: 'document', status: 'published', ...extra }) as KnowledgePageRecord
  assert.equal(finderRowBadges(page({}), undefined), undefined)
  assert.match(render(<>{finderRowBadges(page({}), review(null))}</>), /Reviewed by CTO/)
})

test('one folder read asks about its documents and files only, sorted, at most a hundred', () => {
  const rows = [
    { id: 'c', kind: 'file' }, { id: 'a', kind: 'document' }, { id: 'f', kind: 'folder' }, { id: 's', kind: 'spreadsheet' },
  ] as KnowledgePageRecord[]
  assert.deepEqual(reviewablePageIds(rows), ['a', 'c'])
  const many = Array.from({ length: 150 }, (_, index) => ({ id: `p${String(index).padStart(3, '0')}`, kind: 'document' }))
  assert.equal(reviewablePageIds(many as KnowledgePageRecord[]).length, 100)
})

test('a document review thread’s wake row reads as a wake', () => {
  const message = {
    createdAt: '2026-09-24T09:30:00.000Z',
    metadata: {
      ticketWorkEvent: {
        kind: 'document_woken',
        reason: 'document_changed',
        summary: 'Plan was saved: v4 → v5',
        triggerId: '30000000-0000-4000-8000-000000000005',
      },
    },
    role: 'system',
  } as unknown as ThreadMessageRecord
  const event = ticketWorkEventOf(message)
  assert.ok(event, 'the feed admits it as an event row')
  const markup = render(<TicketWorkEventRow event={event} message={message} />)
  assert.match(markup, /data-work-event="document_woken"/)
  assert.match(markup, /Woken:<\/span> Plan was saved: v4 → v5/)
  assert.doesNotMatch(markup, /Stopped/)
})
