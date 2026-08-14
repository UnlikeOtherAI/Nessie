import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advancePhoneNavigationStack,
  committedPhoneNavigationRoute,
  createPhoneNavigationStack,
  currentPhoneNavigationEntry,
  dropPhoneNavigationEntriesAboveCurrent,
  type PhoneNavigationStack,
} from '../src/layouts/admin-shell/phone-navigation-stack'

type Stack = PhoneNavigationStack<string>

// The stack's retention policy, without a browser: forward pushes append at
// the target depth and preserve lower payloads, Back returns to the exact
// retained screen and only releases the outgoing one once the animation
// completes, same-depth routes update the layer in place, and cross-section
// routes reset.

const stackAt = (...pathnames: string[]): Stack => {
  const [first, ...rest] = pathnames
  assert.ok(first, 'stackAt needs at least one route')
  let stack = createPhoneNavigationStack(first, `payload:${first}`)
  for (const pathname of rest) {
    stack = advancePhoneNavigationStack(stack, pathname, `payload:${pathname}`)
  }
  return stack
}

const keys = (stack: Stack): string[] => stack.entries.map((entry) => entry.key)

test('a cold deep link seeds exactly one entry at its own depth', () => {
  const stack = stackAt('/channels/channel_a')
  assert.equal(stack.entries.length, 1)
  assert.equal(stack.currentIndex, 0)
  assert.equal(currentPhoneNavigationEntry(stack).key, 'channels:channel:channel_a')
  assert.equal(currentPhoneNavigationEntry(stack).depth, 1)
})

test('a forward push preserves the exact lower payloads', () => {
  const root = stackAt('/channels')
  const pushed = advancePhoneNavigationStack(
    root,
    '/channels/channel_a',
    'payload:/channels/channel_a',
  )
  assert.deepEqual(keys(pushed), ['channels:root', 'channels:channel:channel_a'])
  assert.equal(pushed.currentIndex, 1)
  // The root entry object — payload included — is untouched by the push.
  const rootEntry = root.entries[0]
  assert.ok(rootEntry)
  assert.equal(pushed.entries[0], rootEntry)
  assert.equal(pushed.entries[0]?.payload, 'payload:/channels')
})

test('a deeper forward push keeps every lower entry', () => {
  const detail = stackAt('/channels', '/channels/channel_a')
  const deeper = advancePhoneNavigationStack(
    detail,
    '/channels/channel_a/info/members',
    'payload:/channels/channel_a/info/members',
  )
  assert.deepEqual(keys(deeper), [
    'channels:root',
    'channels:channel:channel_a',
    'channels:inspector:channel_a:members',
  ])
  assert.equal(deeper.currentIndex, 2)
  assert.equal(deeper.entries[0]?.payload, 'payload:/channels')
  assert.equal(deeper.entries[1]?.payload, 'payload:/channels/channel_a')
})

test('a forward push replaces any entry previously retained at the target depth', () => {
  // Root → channel A → back → channel B: the depth-1 layer is re-rendered
  // from B's route, not kept from A.
  const atA = stackAt('/channels', '/channels/channel_a')
  const back = advancePhoneNavigationStack(atA, '/channels', 'payload:ignored')
  const atB = advancePhoneNavigationStack(
    dropPhoneNavigationEntriesAboveCurrent(back),
    '/channels/channel_b',
    'payload:/channels/channel_b',
  )
  assert.deepEqual(keys(atB), ['channels:root', 'channels:channel:channel_b'])
  assert.equal(atB.currentIndex, 1)
  assert.equal(atB.entries[0]?.payload, 'payload:/channels')
})

test('a same-depth route updates the current keyed layer in place', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const atB = advancePhoneNavigationStack(atA, '/channels/channel_b', 'payload:/channels/channel_b')
  assert.deepEqual(keys(atB), ['channels:root', 'channels:channel:channel_b'])
  assert.equal(atB.currentIndex, 1)
  assert.equal(atB.entries[1]?.payload, 'payload:/channels/channel_b')
  // Channel tabs stay on the channel's screen but the layer key tracks the
  // exact sub-route.
  const docs = stackAt('/projects', '/projects/project_a')
  const docsTab = advancePhoneNavigationStack(
    docs,
    '/projects/project_a/docs',
    'payload:/projects/project_a/docs',
  )
  assert.equal(docsTab.entries.length, 2)
  assert.equal(docsTab.entries[1]?.key, 'projects:project:project_a:docs')
})

test('Back to a retained lower key preserves that exact entry and keeps the outgoing', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const retainedRoot = atA.entries[0]
  assert.ok(retainedRoot)
  const back = advancePhoneNavigationStack(atA, '/channels', 'payload:new-children')
  // Current moved down to the retained root — whose payload is the captured
  // original, not the Back route's children — and the outgoing channel entry
  // stays mounted for the animation.
  assert.equal(back.currentIndex, 0)
  assert.deepEqual(keys(back), ['channels:root', 'channels:channel:channel_a'])
  assert.equal(back.entries[0], retainedRoot)
  assert.equal(back.entries[0]?.payload, 'payload:/channels')
  assert.equal(back.entries[1]?.payload, 'payload:/channels/channel_a')
  assert.equal(committedPhoneNavigationRoute(back).pathname, '/channels')
})

test('Back across two levels returns to the retained root with both screens above it', () => {
  const deep = stackAt('/channels', '/channels/channel_a', '/channels/channel_a/info/members')
  const back = advancePhoneNavigationStack(deep, '/channels', 'payload:x')
  assert.equal(back.currentIndex, 0)
  assert.deepEqual(keys(back), [
    'channels:root',
    'channels:channel:channel_a',
    'channels:inspector:channel_a:members',
  ])
})

test('cleanup after Back drops only the entries above the current one', () => {
  const deep = stackAt('/channels', '/channels/channel_a', '/channels/channel_a/info/members')
  const back = advancePhoneNavigationStack(deep, '/channels', 'payload:x')
  const cleaned = dropPhoneNavigationEntriesAboveCurrent(back)
  assert.deepEqual(keys(cleaned), ['channels:root'])
  assert.equal(cleaned.currentIndex, 0)
  // A stack with nothing above current is returned unchanged.
  assert.equal(dropPhoneNavigationEntriesAboveCurrent(cleaned), cleaned)
})

test('a same-route commit refreshes only the current payload', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const refreshed = advancePhoneNavigationStack(
    atA,
    '/channels/channel_a',
    'payload:rerendered',
  )
  assert.equal(refreshed.entries[1]?.payload, 'payload:rerendered')
  assert.equal(refreshed.entries[0]?.payload, 'payload:/channels')
})

test('a cross-section route resets the stack', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const reset = advancePhoneNavigationStack(atA, '/projects', 'payload:/projects')
  assert.deepEqual(keys(reset), ['projects:root'])
  assert.equal(reset.currentIndex, 0)
})

test('Back from a cold deep link replaces at the target depth without retaining', () => {
  // The cold stack has only the detail; navigating to the parent builds the
  // root layer from the route — there is no outgoing animation to preserve.
  const cold = stackAt('/channels/channel_a')
  const back = advancePhoneNavigationStack(cold, '/channels', 'payload:/channels')
  assert.deepEqual(keys(back), ['channels:root'])
  assert.equal(back.currentIndex, 0)
  assert.equal(back.entries[0]?.payload, 'payload:/channels')
})

test('unclassified routes reset to a single fallback entry', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const reset = advancePhoneNavigationStack(atA, '/channels/new', 'payload:/channels/new')
  assert.equal(reset.entries.length, 1)
  assert.equal(reset.entries[0]?.key, 'route:/channels/new')
})
