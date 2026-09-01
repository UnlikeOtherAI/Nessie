import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ledgerResearchReportSourceCount,
  ledgerResearchTicket,
} from './deepwater-handoff-ticket.js'
import {
  ticketResult,
} from './deepwater-handoff-guard.test-support.js'

test('research ticket preserves a valid report URL from Ledger structured content', () => {
  const result = ticketResult({
    id: 'rs_ticket-123',
    job_id: 'rs_ticket-123',
    report_url: 'https://ledger.example/v1/research/rs_ticket-123/report',
    status: 'running',
  })
  assert.deepEqual(ledgerResearchTicket(result, 'https://ledger.example'), {
    id: 'rs_ticket-123',
    reportUrl: 'https://ledger.example/v1/research/rs_ticket-123/report',
    status: 'running',
  })
})

test('research ticket rejects malformed, cross-origin, and cross-job report URLs', () => {
  for (const reportUrl of [
    'not a URL',
    'javascript:alert(1)',
    'https://other.example/v1/research/rs_ticket-123/report',
    'https://ledger.example/v1/research/rs_other/report',
    'https://ledger.example/v1/research/rs_ticket-123/report?token=unexpected',
    'https://led\nger.example/v1/research/rs_ticket-123/report',
    '',
    null,
  ]) {
    assert.deepEqual(ledgerResearchTicket(ticketResult({
      id: 'rs_ticket-123',
      job_id: 'rs_ticket-123',
      report_url: reportUrl,
      status: 'running',
    }), 'https://ledger.example'), {
      id: 'rs_ticket-123',
      reportUrl: null,
      status: 'running',
    })
  }
})

test('research report source count comes from the structured references array', () => {
  assert.equal(ledgerResearchReportSourceCount(ticketResult({
    references: [{ url: 'https://one.example' }, { url: 'https://two.example' }],
    report_markdown: '# Report',
  })), 2)
  assert.equal(ledgerResearchReportSourceCount(ticketResult({
    report_markdown: '# Missing references',
  })), null)
})
