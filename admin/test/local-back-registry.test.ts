import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalBackRegistry } from '../src/layouts/admin-shell/local-back/local-back-registry'

const registration = (overrides: Record<string, unknown>) => ({
  active: true,
  id: 'a',
  label: 'Back',
  onBack: () => undefined,
  ...overrides,
})

test('the highest-priority active registration owns the doorway', () => {
  const registry = createLocalBackRegistry()
  const disposeRoot = registry.register(registration({ id: 'root', priority: 20 }))
  registry.register(registration({ id: 'detail', priority: 24 }))

  assert.equal(registry.getSnapshot().active?.id, 'detail')

  // Mount order never decides precedence: re-registering the deeper action
  // after the shallower one keeps ownership with the higher priority.
  const disposeDetail = registry.register(registration({ id: 'detail', priority: 24 }))
  assert.equal(registry.getSnapshot().active?.id, 'detail')

  disposeDetail()
  assert.equal(registry.getSnapshot().active?.id, 'root')
  disposeRoot()
  assert.equal(registry.getSnapshot().active, null)
})

test('an explicit inactive registration never owns the doorway', () => {
  const registry = createLocalBackRegistry()
  registry.register(registration({ id: 'visible', priority: 20 }))
  // A retained but off-screen phone column keeps its registration with
  // active: false; even at a higher priority it must not steal the doorway.
  registry.register(registration({ active: false, id: 'retained', priority: 40 }))

  const snapshot = registry.getSnapshot()
  assert.equal(snapshot.active?.id, 'visible')
  assert.deepEqual(snapshot.activeIds, ['visible'])
})

test('deactivating the owner hands the doorway to the next active action', () => {
  const registry = createLocalBackRegistry()
  registry.register(registration({ id: 'parent', priority: 20 }))
  registry.register(registration({ id: 'child', priority: 22 }))
  assert.equal(registry.getSnapshot().active?.id, 'child')

  registry.register(registration({ active: false, id: 'child', priority: 22 }))
  assert.equal(registry.getSnapshot().active?.id, 'parent')
})

test('the registry is React-free: subscribers see ownership changes and dispatch reaches the latest action', () => {
  const registry = createLocalBackRegistry()
  const seen: Array<string | null> = []
  registry.subscribe(() => seen.push(registry.getSnapshot().active?.id ?? null))

  let calls = 0
  const dispose = registry.register(registration({ id: 'one', onBack: () => { calls += 1 } }))
  registry.getSnapshot().active?.onBack()
  assert.equal(calls, 1)

  dispose()
  registry.getSnapshot().active?.onBack()
  assert.equal(calls, 1)
  assert.deepEqual(seen, ['one', null])
})
