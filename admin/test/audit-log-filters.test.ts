import assert from 'node:assert/strict'
import test from 'node:test'

import {
  auditLogPath,
  auditQueryParams,
  auditWhereValue,
  hasAuditFilters,
  readAuditFilters,
  withAuditFilter,
  withAuditWhere,
  withoutAuditFilters,
} from '../src/components/features/audit/audit-filters.js'
import { auditVerificationSentence } from '../src/components/features/audit/audit-verification.js'
import { auditActionLabel, auditOutcome } from '../src/components/features/audit/audit-words.js'

// Admin › Security's audit log: its filters live in the address (so a trail is
// linkable, and an entry's doorways can write one), a filter change starts
// the result set afresh, and Verify integrity answers in a sentence that never
// claims more than the walk checked.

test('the address reads as the filters, and an unreadable day as none', () => {
  const filters = readAuditFilters(
    new URLSearchParams('actor=u1&action=team.member_added&from=2026-09-01&to=not-a-day&team=t1'),
    'denied',
  )
  assert.deepEqual(filters, {
    action: 'team.member_added',
    actor: 'u1',
    from: '2026-09-01',
    outcome: 'denied',
    project: '',
    team: 't1',
    to: '',
  })
  assert.equal(hasAuditFilters(filters), true)
  assert.equal(hasAuditFilters(readAuditFilters(new URLSearchParams(), 'all')), false)
})

test('a picked day is the whole of that day where the reader is', () => {
  const params = auditQueryParams(readAuditFilters(new URLSearchParams('from=2026-09-01&to=2026-09-02'), 'all'))
  assert.equal(params.from, new Date('2026-09-01T00:00:00.000').toISOString())
  assert.equal(params.to, new Date('2026-09-02T23:59:59.999').toISOString())
  assert.equal(params.outcome, undefined)
})

test('the API is asked by its own names, unset filters left out', () => {
  const params = auditQueryParams(readAuditFilters(new URLSearchParams('actor=u1&project=p1'), 'error'))
  assert.deepEqual(params, {
    action: undefined,
    actorId: 'u1',
    from: undefined,
    outcome: 'error',
    projectId: 'p1',
    teamId: undefined,
    to: undefined,
  })
})

test('a filter change drops the page the old result set was on, and keeps the tab', () => {
  const next = withAuditFilter(new URLSearchParams('tab=audit&cursor=c&direction=forward&page=3'), 'actor', 'u2')
  assert.equal(next.toString(), 'tab=audit&actor=u2')
  assert.equal(withAuditFilter(next, 'actor', '').toString(), 'tab=audit')
})

test('team and project are one where-choice, written in one replace', () => {
  const inTeam = withAuditWhere(new URLSearchParams('project=p1&page=2'), 'team:t1')
  assert.equal(inTeam.toString(), 'team=t1')
  assert.equal(auditWhereValue({ project: '', team: 't1' }), 'team:t1')
  const inProject = withAuditWhere(inTeam, 'project:p1')
  assert.equal(inProject.toString(), 'project=p1')
  assert.equal(withAuditWhere(inProject, '').toString(), '')
})

test('clearing takes every filter and page param, and nothing else', () => {
  const cleared = withoutAuditFilters(
    new URLSearchParams('tab=audit&actor=u1&outcome=error&from=2026-09-01&cursor=c&limit=50'),
  )
  assert.equal(cleared.toString(), 'tab=audit&limit=50')
})

test('an entry’s doorways open the trail narrowed to one filter', () => {
  assert.equal(auditLogPath({ actor: 'u1' }), '/admin/security?actor=u1')
  assert.equal(auditLogPath({ action: 'team.member_added' }), '/admin/security?action=team.member_added')
  assert.equal(auditLogPath({}), '/admin/security')
})

test('an action code reads as words in the admin’s own vocabulary', () => {
  assert.equal(auditActionLabel('team.member_added'), 'Team member added')
  assert.equal(auditActionLabel('kb.page.updated'), 'Document page updated')
  assert.equal(auditActionLabel('organization.member_invited'), 'Organisation member invited')
  assert.equal(auditActionLabel('secret.revoked'), 'Key revoked')
  assert.equal(auditOutcome('denied').label, 'Refused')
  assert.equal(auditOutcome('mystery').label, 'mystery')
})

test('an intact chain is all of it, and the entries it could not check are said', () => {
  const intact = auditVerificationSentence({ checkedCount: 12431, unchainedCount: 0, valid: true })
  assert.equal(intact.text, 'All 12,431 entries verified, none altered.')
  assert.equal(intact.tone, 'success')
  assert.equal(intact.detail, undefined)

  const withOlder = auditVerificationSentence({ checkedCount: 3, unchainedCount: 1, valid: true })
  assert.equal(withOlder.text, 'All 3 entries verified, none altered.')
  assert.match(withOlder.detail ?? '', /^1 entry written before verification existed has no fingerprint/)

  assert.equal(
    auditVerificationSentence({ checkedCount: 0, unchainedCount: 0, valid: true }).text,
    'There are no entries to verify yet.',
  )
  assert.match(
    auditVerificationSentence({ checkedCount: 0, unchainedCount: 5, valid: true }).text,
    /^None of the 5 entries can be checked/,
  )
})

test('a break says what kind of change it found, how far the trail holds, and where', () => {
  const broken = auditVerificationSentence({
    checkedCount: 1204,
    firstBreak: { id: 'entry-9', reason: 'entry_hash_mismatch' },
    unchainedCount: 0,
    valid: false,
  })
  assert.equal(broken.text, 'This entry was changed after it was written.')
  assert.equal(broken.detail, 'The 1,204 entries before it are intact.')
  assert.equal(broken.brokenEntryId, 'entry-9')
  assert.equal(broken.tone, 'danger')

  assert.equal(
    auditVerificationSentence({
      checkedCount: 0,
      firstBreak: { id: 'entry-1', reason: 'broken_link' },
      unchainedCount: 0,
      valid: false,
    }).detail,
    'No entry before it could be confirmed.',
  )
})
