import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { act, createElement as h } from 'react'

import type { AgentMention } from '@nessie/schemas'
import {
  secretCaptureProjectId,
  useSecretCapture,
} from '../src/components/features/channels/useSecretCapture.js'
import type { SecretRecord } from '../src/facades/secrets/hooks.js'
import type { ChannelRecord } from '../src/lib/api-client.js'

/**
 * `useSecretCapture`, the interception every message composer runs before a
 * request — the conversation composer and the New message page alike
 * (docs/secret-management-spec.md → "Capture and ingestion"). A draft carrying
 * a credential is held instead of sent, the raw bytes live only in the
 * capture, and saving drops them before handing back the masked turn to send.
 * `secretCaptureProjectId` decides which project, if any, a room's capture
 * may offer beside Personal.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/channels/new',
})

type SecretCaptureGate = ReturnType<typeof useSecretCapture>

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.window.navigator,
  window: dom.window,
}

const installDom = () => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

// Assembled, so no scanner reads the source itself as carrying a key.
const KEY = ['sk', 'proj', 'TESTONLY0123456789abcdefghij'].join('-')
const MASKED = `sk-proj-${'•'.repeat(12)}`
const MENTIONS = [
  { agentId: '00000000-0000-4000-8000-000000000001', type: 'agent' },
] as AgentMention[]
const saved = (name: string) => ({ name }) as SecretRecord

const mount = async (projectId: string | null) => {
  const restoreDom = installDom()
  // Only once the DOM is in place: react-dom decides which events the browser
  // supports when it is first evaluated, and one loaded without a window falls
  // back to an old IE path that throws on every focused input after it.
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  let gate: SecretCaptureGate | null = null
  const Probe = () => {
    gate = useSecretCapture({ projectId })
    return null
  }
  await act(async () => { root.render(h(Probe)) })

  // Always the latest render's, since each one closes over its own capture.
  const current = (): SecretCaptureGate => {
    assert.ok(gate, 'the hook rendered')
    return gate
  }
  return {
    close: async () => {
      await act(async () => { root.unmount() })
      container.remove()
      restoreDom()
    },
    current,
    dismiss: async () => {
      await act(async () => { current().dismiss() })
    },
    intercept: async (
      text: string,
      replacementMode: 'file' | 'message' = 'message',
    ): Promise<boolean> => {
      let held = false
      await act(async () => {
        held = current().intercept(text, { agentMentions: MENTIONS, replacementMode })
      })
      return held
    },
    release: async (name: string) => {
      let turn: ReturnType<SecretCaptureGate['release']> = null
      await act(async () => { turn = current().release(saved(name)) })
      return turn as ReturnType<SecretCaptureGate['release']>
    },
  }
}

test('a draft carrying a credential is held, and only the capture has its bytes', async () => {
  const gate = await mount(null)
  try {
    assert.equal(await gate.intercept(`Deploy with ${KEY} please`), true)
    const capture = gate.current().capture
    assert.ok(capture, 'the capture the dialog renders')
    assert.equal(capture.value, KEY)
    assert.equal(capture.detected.type, 'openai_api_key')
    assert.equal(capture.replacementContent, `Deploy with ${MASKED} please`)
    assert.deepEqual(capture.agentMentions, MENTIONS)
    assert.equal(capture.replacementMode, 'message')
    // Nothing to offer beside Personal, the one scope every person may write.
    assert.equal(capture.projectId, undefined)
  } finally {
    await gate.close()
  }
})

test('a project the composer may offer rides along as a choice', async () => {
  const gate = await mount('project-1')
  try {
    assert.equal(await gate.intercept(KEY), true)
    assert.equal(gate.current().capture?.projectId, 'project-1')
  } finally {
    await gate.close()
  }
})

test('a draft with no credential goes on to be sent', async () => {
  const gate = await mount(null)
  try {
    assert.equal(await gate.intercept('Deploy it after lunch, sk-learn is fine'), false)
    assert.equal(gate.current().capture, null)
  } finally {
    await gate.close()
  }
})

test('saving drops the raw value and hands back only the masked turn, once', async () => {
  const gate = await mount(null)
  try {
    await gate.intercept(`Deploy with ${KEY} please`)
    const turn = await gate.release('OPENAI_API_KEY')
    assert.ok(turn, 'a held capture has a turn to send')
    assert.deepEqual(turn, {
      agentMentions: MENTIONS,
      content: `Deploy with ${MASKED} please\n\n`
        + '[Secret protected and saved as OPENAI_API_KEY; the value was replaced.]',
      replacementMode: 'message',
    })
    assert.equal(gate.current().capture, null, 'the bytes are gone before the send')
    assert.equal(await gate.release('OPENAI_API_KEY'), null, 'and nothing is sent twice')
    // The masked turn goes back through the same send, so it must pass.
    assert.equal(await gate.intercept(turn.content), false)
  } finally {
    await gate.close()
  }
})

test('an oversize paste bound for a file is held the same way and resent as one', async () => {
  const gate = await mount('project-1')
  try {
    assert.equal(await gate.intercept(`config:\n${KEY}`, 'file'), true)
    const turn = await gate.release('OPENAI_API_KEY')
    assert.equal(turn?.replacementMode, 'file')
    assert.doesNotMatch(turn?.content ?? '', /TESTONLY/)
  } finally {
    await gate.close()
  }
})

test('discarding drops the capture and leaves nothing to send', async () => {
  const gate = await mount(null)
  try {
    await gate.intercept(KEY)
    await gate.dismiss()
    assert.equal(gate.current().capture, null)
    assert.equal(await gate.release('OPENAI_API_KEY'), null)
  } finally {
    await gate.close()
  }
})

const room = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  isGroupDm: false,
  projectId: 'project-1',
  scope: 'project',
  type: 'standard',
  ...overrides,
}) as ChannelRecord

test('only an organisation owner in an ordinary project room is offered its project', () => {
  const owner = { viewerIsOwner: true }
  assert.equal(secretCaptureProjectId(room(), owner), 'project-1')
  // `canManageSecretScope` refuses every other role a project write, admins too.
  assert.equal(secretCaptureProjectId(room(), { viewerIsOwner: false }), null)
})

test('a room whose project is only where it is stored never offers it', () => {
  const owner = { viewerIsOwner: true }
  for (const [kind, stored] of [
    ['a DM', room({ type: 'dm' })],
    ['a group DM', room({ isGroupDm: true })],
    ['a Personal Assistant conversation', room({ systemChannelType: 'personal_assistant' })],
    ['a global agent’s home DM', room({ systemChannelType: 'system_agent' })],
    ['an agent mailbox room', room({ systemChannelType: 'agent_email' })],
    ['a standalone room', room({ scope: 'standalone' })],
    ['a record that does not say', room({ scope: undefined })],
  ] as const) {
    assert.equal(secretCaptureProjectId(stored, owner), null, kind)
  }
  // Before a room exists: the New message page.
  assert.equal(secretCaptureProjectId(null, owner), null)
})
