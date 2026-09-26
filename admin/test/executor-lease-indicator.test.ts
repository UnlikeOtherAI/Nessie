import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  executorLeaseDescription,
  executorLeaseLabel,
  executorLeasesCarriedFrom,
  executorLeaseUntil,
} from '../src/components/features/executors/executor-lease-presentation'
import {
  executorLeaseRecheckDelay,
  parseExecutorLeaseChangedFrame,
} from '../src/facades/executors/leases'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const lease = { executorLabel: 'Minis', expiresAt: '2026-09-23T21:40:00.000Z' }

test('the indicator reads "Minis · local apps · until HH:MM", naming the agent only when it must', () => {
  const until = executorLeaseUntil(lease.expiresAt)
  assert.match(until, /\d{1,2}:\d{2}/)
  assert.equal(executorLeaseLabel(lease), `Minis · local apps · until ${until}`)
  assert.equal(executorLeaseLabel(lease, 'CTO'), `CTO · Minis · local apps · until ${until}`)
  assert.match(executorLeaseDescription(lease, 'CTO'), /^CTO can use local apps on Minis for your own messages/)
  assert.match(executorLeaseDescription(lease, null), /^The agent can use local apps on Minis/)
})

test('a shown expiry is re-read when it would pass, and never later than five minutes', () => {
  const now = Date.parse('2026-09-23T20:00:00.000Z')
  assert.equal(executorLeaseRecheckDelay(undefined, now), false)
  assert.equal(executorLeaseRecheckDelay([], now), false, 'nothing held, nothing to expire')
  assert.equal(executorLeaseRecheckDelay([{ expiresAt: '2026-09-23T20:01:00.000Z' }], now), 61_000)
  assert.equal(executorLeaseRecheckDelay([
    { expiresAt: '2026-09-23T21:40:00.000Z' }, { expiresAt: '2026-09-23T20:02:00.000Z' },
  ], now), 121_000, 'the soonest lease decides')
  assert.equal(executorLeaseRecheckDelay([{ expiresAt: '2026-09-23T21:40:00.000Z' }], now), 5 * 60_000)
  assert.equal(executorLeaseRecheckDelay([{ expiresAt: '2026-09-23T19:00:00.000Z' }], now), 1_000)
})

test('only a well-formed executor.lease.changed frame invalidates, and a bad one breaks nothing', () => {
  const data = JSON.stringify({
    type: 'event', event: 'executor.lease.changed', ts: '2026-09-23T20:00:00.000Z',
    data: { leaseId: '99999999-9999-4999-8999-999999999991', threadId: '66666666-6666-4666-8666-666666666666' },
  })
  assert.deepEqual(
    parseExecutorLeaseChangedFrame({ data, event: 'executor.lease.changed', id: '1' }),
    { threadId: '66666666-6666-4666-8666-666666666666' },
  )
  assert.equal(parseExecutorLeaseChangedFrame({ data, event: 'alert.created', id: '1' }), null)
  assert.equal(parseExecutorLeaseChangedFrame({ data: '{not json', event: 'executor.lease.changed', id: '1' }), null)
  assert.equal(parseExecutorLeaseChangedFrame({
    data: JSON.stringify({ type: 'event', event: 'executor.lease.changed', ts: 'x', data: { leaseId: 'nope' } }),
    event: 'executor.lease.changed', id: '1',
  }), null)
})

test('a composer shows only the leases a message sent from it would carry', () => {
  const room = { id: 'room', rootMessageId: 'launch', wholeThread: false }
  const conversation = { id: 'conversation', rootMessageId: 'opening', wholeThread: true }
  const leases = [room, conversation]
  assert.deepEqual(executorLeasesCarriedFrom(leases, null), [conversation],
    'a top-level post carries only a lease covering the whole thread')
  assert.deepEqual(executorLeasesCarriedFrom(leases, 'launch'), [room, conversation],
    'a reply under the launch carries its lease')
  assert.deepEqual(executorLeasesCarriedFrom(leases, 'elsewhere'), [conversation],
    'a reply under anything else does not')
})

test('the reply panel hands its own root to the indicator, and the main composer none', () => {
  const panel = readSource('../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx')
  assert.match(panel, /<ExecutorLeaseIndicator[^>]*rootMessageId=\{openRootMessageId\}/)
  assert.match(panel, /executorLeaseIndicator=\{executorLeaseIndicator\}/)
  const launcher = readSource('../src/pages/channels/useExecutorRunLauncher.tsx')
  assert.match(launcher, /<ExecutorLeaseIndicator[^>]*rootMessageId=\{null\}/)
})

test('the indicator lives in the composer toolbar, beside Run on a computer, never at rest', () => {
  const composer = readSource('../src/components/features/channels/ChannelComposer.tsx')
  const bar = composer.slice(composer.indexOf('admin-compose-bar'), composer.indexOf('admin-compose-send-slot'))
  const run = bar.indexOf('aria-label="Run on a computer"')
  const indicator = bar.indexOf('{executorLeaseIndicator}')
  assert.ok(run > 0 && indicator > run, 'rendered inside the toolbar, after Run on a computer')
  assert.ok(indicator < bar.indexOf('<ComposerEmojiButton'), 'and before the next glyph')
})
