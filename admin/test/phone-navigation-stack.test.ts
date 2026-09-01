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
const layers = (stack: Stack): string[] => stack.entries.map((entry) => entry.layerKey)

test('a cold deep link seeds exactly one entry at its semantic depth', () => {
  const stack = stackAt('/channels/channel_a/info/members/add')
  assert.equal(stack.entries.length, 1)
  assert.equal(stack.currentIndex, 0)
  assert.equal(currentPhoneNavigationEntry(stack).key, 'channels:channel')
  assert.equal(currentPhoneNavigationEntry(stack).depth, 4)
})

test('a forward push preserves the exact live lower entry', () => {
  const root = stackAt('/channels')
  const pushed = advancePhoneNavigationStack(
    root,
    '/channels/channel_a',
    'payload:/channels/channel_a',
  )
  assert.deepEqual(keys(pushed), ['root:channels:/channels', 'channels:channel'])
  assert.deepEqual(layers(pushed), [
    'channels:0:root:channels:/channels',
    'channels:1:channels:channel',
  ])
  assert.equal(pushed.currentIndex, 1)
  assert.equal(pushed.entries[0], root.entries[0])
  assert.equal(pushed.entries[0]?.payload, 'payload:/channels')
})

test('deeper pushes keep each lower route even when the screen key repeats', () => {
  const stack = stackAt(
    '/channels',
    '/channels/channel_a',
    '/channels/channel_a/info',
    '/channels/channel_a/info/members',
  )
  assert.deepEqual(keys(stack), [
    'root:channels:/channels',
    'channels:channel',
    'channels:channel',
    'channels:channel',
  ])
  assert.deepEqual(layers(stack), [
    'channels:0:root:channels:/channels',
    'channels:1:channels:channel',
    'channels:2:channels:channel',
    'channels:3:channels:channel',
  ])
  assert.equal(stack.currentIndex, 3)
})

test('a new push after Back replaces the released target-depth entry', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const back = advancePhoneNavigationStack(atA, '/channels', 'payload:root-refreshed')
  const cleaned = dropPhoneNavigationEntriesAboveCurrent(back)
  const atB = advancePhoneNavigationStack(
    cleaned,
    '/channels/channel_b',
    'payload:/channels/channel_b',
  )
  assert.deepEqual(keys(atB), ['root:channels:/channels', 'channels:channel'])
  assert.equal(atB.currentIndex, 1)
  assert.equal(atB.entries[0]?.payload, 'payload:root-refreshed')
  assert.equal(atB.entries[1]?.pathname, '/channels/channel_b')
})

test('same-depth routes refresh one stable layer without growing the stack', () => {
  const atA = stackAt('/channels', '/channels/channel_a')
  const atB = advancePhoneNavigationStack(
    atA,
    '/channels/channel_b',
    'payload:/channels/channel_b',
  )
  assert.equal(atB.entries.length, 2)
  assert.equal(atB.entries[1]?.key, 'channels:channel')
  assert.equal(atB.entries[1]?.layerKey, atA.entries[1]?.layerKey)
  assert.equal(atB.entries[1]?.payload, 'payload:/channels/channel_b')

  const project = stackAt('/projects', '/projects/project_a/board')
  const docs = advancePhoneNavigationStack(
    project,
    '/projects/project_a/docs',
    'payload:docs',
  )
  assert.equal(docs.entries.length, 2)
  assert.equal(docs.entries[1]?.key, 'projects:project')
  assert.equal(docs.entries[1]?.layerKey, project.entries[1]?.layerKey)
})

test('Back targets the retained layer, refreshes its route payload, and keeps outgoing DOM', () => {
  const detail = stackAt('/channels', '/channels/channel_a')
  const retainedLayerKey = detail.entries[0]?.layerKey
  const back = advancePhoneNavigationStack(detail, '/channels', 'payload:new-root')
  assert.equal(back.currentIndex, 0)
  assert.deepEqual(keys(back), ['root:channels:/channels', 'channels:channel'])
  assert.equal(back.entries[0]?.layerKey, retainedLayerKey)
  assert.equal(back.entries[0]?.payload, 'payload:new-root')
  assert.equal(back.entries[1]?.payload, 'payload:/channels/channel_a')
  assert.equal(committedPhoneNavigationRoute(back).pathname, '/channels')
})

test('thread Back retains the live conversation until its slide-out completes', () => {
  const thread = stackAt(
    '/channels',
    '/channels/channel_a',
    '/channels/channel_a/threads/thread_a/replies/message_a',
  )
  assert.equal(thread.currentIndex, 2)
  assert.deepEqual(keys(thread), [
    'root:channels:/channels',
    'channels:channel',
    'channels:channel',
  ])
  assert.deepEqual(layers(thread), [
    'channels:0:root:channels:/channels',
    'channels:1:channels:channel',
    'channels:2:channels:channel',
  ])

  const back = advancePhoneNavigationStack(
    thread,
    '/channels/channel_a',
    'payload:conversation-refreshed',
  )
  assert.equal(back.currentIndex, 1)
  assert.equal(back.entries.length, 3)
  assert.equal(back.entries[1]?.payload, 'payload:conversation-refreshed')
  assert.equal(back.entries[2]?.pathname, '/channels/channel_a/threads/thread_a/replies/message_a')
  assert.deepEqual(dropPhoneNavigationEntriesAboveCurrent(back).entries.map((entry) => entry.pathname), [
    '/channels',
    '/channels/channel_a',
  ])
})

test('Back across levels retains the outgoing chain until cleanup', () => {
  const deep = stackAt(
    '/channels',
    '/channels/channel_a',
    '/channels/channel_a/info',
    '/channels/channel_a/info/members',
  )
  const back = advancePhoneNavigationStack(deep, '/channels', 'payload:root')
  assert.equal(back.currentIndex, 0)
  assert.equal(back.entries.length, 4)
  const cleaned = dropPhoneNavigationEntriesAboveCurrent(back)
  assert.deepEqual(keys(cleaned), ['root:channels:/channels'])
  assert.equal(cleaned.currentIndex, 0)
  assert.equal(dropPhoneNavigationEntriesAboveCurrent(cleaned), cleaned)
})

test('a same-route render refreshes only the current payload', () => {
  const detail = stackAt('/channels', '/channels/channel_a')
  const refreshed = advancePhoneNavigationStack(
    detail,
    '/channels/channel_a',
    'payload:rerendered',
  )
  assert.equal(refreshed.entries[1]?.payload, 'payload:rerendered')
  assert.equal(refreshed.entries[0]?.payload, 'payload:/channels')
})

test('cross-section navigation resets to one fresh stack', () => {
  const detail = stackAt('/channels', '/channels/channel_a')
  const reset = advancePhoneNavigationStack(detail, '/projects', 'payload:/projects')
  assert.deepEqual(keys(reset), ['root:projects:/projects'])
  assert.equal(reset.currentIndex, 0)
})

test('Back from a cold deep link never fabricates an unseen predecessor', () => {
  const cold = stackAt('/channels/channel_a/info/members/add')
  const parent = advancePhoneNavigationStack(
    cold,
    '/channels/channel_a/info/members',
    'payload:members',
  )
  assert.equal(parent.entries.length, 1)
  assert.equal(parent.currentIndex, 0)
  assert.equal(parent.entries[0]?.depth, 3)
  assert.equal(parent.entries[0]?.payload, 'payload:members')
})

// The registry is total, so compose is a screen like any other: it swaps in
// place beside a conversation (same depth) rather than being refused. Only a
// path with no row at all — which the totality lint makes impossible for a
// real route — still throws.
test('compose swaps in place beside a conversation; an unclassified path is still refused', () => {
  const detail = stackAt('/channels', '/channels/channel_a')
  const compose = advancePhoneNavigationStack(detail, '/channels/new', 'payload:compose')
  assert.equal(compose.currentIndex, 1)
  assert.equal(compose.entries.length, 2)
  assert.equal(compose.entries[1]?.payload, 'payload:compose')
  assert.equal(compose.entries[0]?.pathname, '/channels')

  assert.throws(
    () => advancePhoneNavigationStack(detail, '/totally/unknown', 'payload:unknown'),
    /cannot classify/,
  )
})
