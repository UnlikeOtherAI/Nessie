import assert from 'node:assert/strict'
import test from 'node:test'
import { hasBackAction, resolveBack } from '../src/navigation/back'
import { canGoBack, canGoForward, lastPathInSection, resolveSectionTarget } from '../src/navigation/history'
import {
  __resetStackTransitionState,
  beginStackTransition,
  isStackTransitioning,
  whenStackSettled,
} from '../src/navigation/transition-state'
import {
  createPhoneHistoryLedger,
  recordPhoneHistory,
} from '../src/layouts/admin-shell/phone-navigation-ledger'

const ledgerOf = (paths: string[]) => {
  let ledger = createPhoneHistoryLedger('k0', paths[0] ?? '/channels')
  paths.slice(1).forEach((path, index) => {
    ledger = recordPhoneHistory(ledger, 'PUSH', `k${index + 1}`, path)
  })
  return ledger
}

test('an active owner wins Back and carries its swipeability', () => {
  const owner = { active: true, id: 'editor', label: 'Back from page editor', onBack: () => {}, swipeable: false }
  const action = resolveBack({
    pathname: '/knowledge-base/spaces/s1',
    owners: { active: owner, activeIds: ['editor'] },
    ledger: ledgerOf(['/knowledge-base', '/knowledge-base/spaces/s1']),
  })
  assert.equal(action?.kind, 'owner')
  assert.equal(action?.label, 'Back from page editor')
  assert.equal(action?.swipeable, false)
})

test('an owner without a swipeable flag is swipeable', () => {
  const owner = { active: true, id: 'sheet', label: 'Close attachments', onBack: () => {} }
  const action = resolveBack({ pathname: '/channels/c1', owners: { active: owner, activeIds: ['sheet'] }, ledger: null })
  assert.equal(action?.swipeable, true)
})

test('route Back pops when the previous entry is the parent, else replaces', () => {
  const popped = resolveBack({
    pathname: '/channels/c1',
    owners: { active: null, activeIds: [] },
    ledger: ledgerOf(['/channels', '/channels/c1']),
  })
  assert.deepEqual(popped, {
    kind: 'route', label: 'Back to Channels', mode: 'pop', to: '/channels', swipeable: true,
  })

  const replaced = resolveBack({
    pathname: '/channels/c1',
    owners: null,
    ledger: ledgerOf(['/channels/c1']),
  })
  assert.equal(replaced?.kind, 'route')
  assert.equal(replaced?.mode, 'replace')
  assert.equal(replaced?.to, '/channels')
})

test('an origin screen pops to the real predecessor and says only "Back"', () => {
  const popped = resolveBack({
    pathname: '/alerts',
    owners: null,
    ledger: ledgerOf(['/channels', '/channels/c1', '/alerts']),
  })
  assert.deepEqual(popped, { kind: 'route', label: 'Back', mode: 'pop', to: '/channels/c1', swipeable: true })

  // A cold deep link falls back to the declared parent, and names it.
  const cold = resolveBack({ pathname: '/alerts', owners: null, ledger: ledgerOf(['/alerts']) })
  assert.deepEqual(cold, { kind: 'route', label: 'Back to Admin', mode: 'replace', to: '/settings', swipeable: true })

  // Operational usage is owner-only and listed on Admin; /ops is
  // super-admin-only, so it is never the fallback.
  const usage = resolveBack({ pathname: '/ops/usage', owners: null, ledger: ledgerOf(['/settings', '/ops/usage']) })
  assert.deepEqual(usage, { kind: 'route', label: 'Back', mode: 'pop', to: '/settings', swipeable: true })
  assert.equal(resolveBack({ pathname: '/ops/usage', owners: null, ledger: null })?.to, '/settings')
})

test('a root has no Back action', () => {
  assert.equal(resolveBack({ pathname: '/channels', owners: null, ledger: ledgerOf(['/channels']) }), null)
  assert.equal(hasBackAction({ pathname: '/projects', owners: null, ledger: null }), false)
  assert.equal(hasBackAction({ pathname: '/projects/p1', owners: null, ledger: null }), true)
})

test('history reads come from the ledger, not a private counter', () => {
  let ledger = ledgerOf(['/channels', '/channels/c1', '/projects'])
  assert.equal(canGoBack(ledger), true)
  assert.equal(canGoForward(ledger), false)
  ledger = recordPhoneHistory(ledger, 'POP', 'k1', '/channels/c1')
  assert.equal(canGoForward(ledger), true)
  assert.equal(canGoBack(ledger), true)
  ledger = recordPhoneHistory(ledger, 'POP', 'k0', '/channels')
  assert.equal(canGoBack(ledger), false)
})

test('a section tab returns to the last place visited in that section this session', () => {
  const ledger = ledgerOf(['/channels', '/agents', '/agents/a1?tab=tools', '/channels/c2'])
  assert.equal(lastPathInSection(ledger, 'admin'), '/agents/a1?tab=tools')
  assert.equal(lastPathInSection(ledger, 'channels'), '/channels/c2')
  assert.equal(lastPathInSection(ledger, 'knowledge'), null)
  assert.equal(resolveSectionTarget(ledger, 'knowledge', '/knowledge-base'), '/knowledge-base')
  assert.equal(resolveSectionTarget(ledger, 'admin', '/settings'), '/agents/a1?tab=tools')
})

test('the transition signal counts in-flight transitions and releases waiters on settle', async () => {
  __resetStackTransitionState()
  assert.equal(isStackTransitioning(), false)
  await whenStackSettled()

  const endFirst = beginStackTransition()
  const endSecond = beginStackTransition()
  assert.equal(isStackTransitioning(), true)
  let settled = false
  void whenStackSettled().then(() => { settled = true })
  endFirst()
  endFirst()
  await Promise.resolve()
  assert.equal(settled, false, 'one transition still runs')
  endSecond()
  await Promise.resolve()
  assert.equal(settled, true)
  assert.equal(isStackTransitioning(), false)
})
