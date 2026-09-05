import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MessageRoleSchema,
  WsEventSchema,
  parseChannelId,
  parseOrganizationId,
  type WsScope,
} from '@nessie/schemas'

import {
  publishMessageNew,
  publishMessageReply,
} from '../src/services/message-delivery.js'

/**
 * `message.new` used to be hand-assembled at six call sites. One of them typed
 * `role: 'agent'`, which is not a `MessageRoleSchema` value, so `publishWs`'s
 * parse threw and a bare `catch {}` discarded it: the voice call record never
 * announced itself and nothing logged that it hadn't.
 *
 * These tests pin the envelope to one builder and prove it produces an event
 * the wire accepts for every role a message row can actually carry.
 */

const CHANNEL_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b001'
const ORGANIZATION_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b002'
const THREAD_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b003'
const USER_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b004'
const AGENT_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b005'
const MESSAGE_ID = '9c0e1e94-4b1b-4a2e-9f21-2a5cf0f5b006'

type Published = { data: unknown; event: string; scopes: WsScope[] }

const buildDeps = () => {
  const published: Published[] = []
  const scopeInputs: Array<{ systemChannelType?: string | null }> = []
  return {
    deps: {
      buildChannelRealtimeScopes: (input: {
        channelId: string
        organizationId: string
        systemChannelType?: string | null
      }): WsScope[] => {
        scopeInputs.push({ systemChannelType: input.systemChannelType })
        return input.systemChannelType === 'personal_assistant'
          ? [{ kind: 'channel', channelId: parseChannelId(input.channelId) }]
          : [
              {
                kind: 'organization',
                organizationId: parseOrganizationId(input.organizationId),
              },
              { kind: 'channel', channelId: parseChannelId(input.channelId) },
            ]
      },
      realtimeHub: {
        publishWs: async (scopes: WsScope[], input: { data: unknown; event: string }) => {
          published.push({ data: input.data, event: input.event, scopes })
          return undefined
        },
      },
    },
    published,
    scopeInputs,
  }
}

const channel = { id: CHANNEL_ID, organizationId: ORGANIZATION_ID }

test('a message.new envelope is a valid wire event for every message role', async () => {
  for (const role of MessageRoleSchema.options) {
    const { deps, published } = buildDeps()

    await publishMessageNew(deps, {
      channel,
      message: { content: 'hello', id: MESSAGE_ID, role, userId: USER_ID },
      threadId: THREAD_ID,
    })

    const sent = published[0]
    assert.ok(sent)
    const parsed = WsEventSchema.parse({
      type: 'event',
      event: sent.event,
      data: sent.data,
      ts: new Date().toISOString(),
    })
    assert.equal(parsed.event, 'message.new')
    // No `agentId` key at all — absent authorship is omitted rather than
    // published as an explicit `undefined`.
    assert.deepEqual(parsed.data, {
      authorUserId: USER_ID,
      channelId: CHANNEL_ID,
      contentPreview: 'hello',
      messageId: MESSAGE_ID,
      role,
      threadId: THREAD_ID,
    })
  }
})

test('a message.reply envelope carries its root and is a valid wire event', async () => {
  const { deps, published } = buildDeps()

  await publishMessageReply(deps, {
    channel,
    message: { content: 'a reply', id: MESSAGE_ID, role: 'user', userId: USER_ID },
    rootMessageId: THREAD_ID,
    threadId: THREAD_ID,
  })

  const sent = published[0]
  assert.ok(sent)
  const parsed = WsEventSchema.parse({
    type: 'event',
    event: sent.event,
    data: sent.data,
    ts: new Date().toISOString(),
  })
  assert.equal(parsed.event, 'message.reply')
  assert.equal(
    (parsed.data as { rootMessageId: string }).rootMessageId,
    THREAD_ID,
  )
})

test('the call-record announcement the voice route now sends is a valid wire event', async () => {
  const { deps, published, scopeInputs } = buildDeps()

  // Exactly what `registerVoiceCallRecordRoute` publishes: the record's own
  // role, read off the row `writeVoiceCallRecord` created, in the PA channel.
  await publishMessageNew(deps, {
    channel: { ...channel, systemChannelType: 'personal_assistant' },
    message: {
      agentId: AGENT_ID,
      content: 'Voice call',
      id: MESSAGE_ID,
      role: 'assistant',
    },
    threadId: THREAD_ID,
  })

  const sent = published[0]
  assert.ok(sent)
  WsEventSchema.parse({
    type: 'event',
    event: sent.event,
    data: sent.data,
    ts: new Date().toISOString(),
  })
  assert.equal((sent.data as { agentId?: string }).agentId, AGENT_ID)
  assert.equal((sent.data as { authorUserId?: string }).authorUserId, undefined)
  // The system channel type reaches the scope builder, so a delegated system DM
  // is announced to its channel rather than the whole organization.
  assert.deepEqual(scopeInputs, [{ systemChannelType: 'personal_assistant' }])
  assert.equal(sent.scopes.length, 1)
})

test('the role a publisher hands over must be a wire role, not a call-site literal', async () => {
  const { deps, published } = buildDeps()

  await assert.rejects(() => publishMessageNew(deps, {
    channel,
    // The exact literal that was published for months and silently discarded.
    message: { content: 'Voice call', id: MESSAGE_ID, role: 'agent' },
    threadId: THREAD_ID,
  }))
  assert.equal(published.length, 0)
})

test('no message announcement is hand-assembled in the routes that used to build one', () => {
  for (const path of [
    'src/routes/voice-call-record.ts',
    'src/routes/executors.ts',
    'src/routes/external-agent.ts',
    'src/services/integration-handoffs.ts',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(source, /publishMessageNew/, `${path} announces through the shared builder`)
    assert.doesNotMatch(
      source,
      /event: 'message\.new'/,
      `${path} must not build a message.new payload of its own`,
    )
  }
})

test('the card press announces through the API scope rule, not a hand-built pair', () => {
  // A press inside a delegated system DM must not carry the organization scope
  // — `publishMessageReply` runs the announcement through
  // `buildChannelRealtimeScopes`, which drops it. See
  // `agent-card-realtime-scope.test.ts` for the behavioural proof.
  const source = readFileSync(new URL('../src/routes/agent-cards.ts', import.meta.url), 'utf8')
  assert.match(source, /publishMessageReply/)
  assert.match(source, /buildChannelRealtimeScopes/)
  assert.doesNotMatch(
    source,
    /kind: 'organization'/,
    'the route must not assemble an organization scope of its own',
  )
})

test('no message announcement is hand-assembled in the worker either', () => {
  // The worker announces messages too — the orchestration notice, the PA's
  // cards, the mailbox hand-off, the missed-call record — and used to retype
  // the envelope at each one. `publishMessageEnvelope` lives in
  // `@nessie/runtime` so both processes reach the same builder.
  for (const path of [
    '../worker/src/run/orchestrate-publications.ts',
    '../worker/src/run/orchestration-notice.ts',
    '../worker/src/run/pa-tools/google-access.ts',
    '../worker/src/run/pa-tools/comms-card.ts',
    '../worker/src/control/mailbox.ts',
    '../worker/src/control/call-lifecycle.ts',
    // The run executor's own announcement — the last hand-built envelope.
    '../worker/src/run/execute/realtime.ts',
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(source, /publishMessageEnvelope/, `${path} announces through the shared builder`)
    assert.doesNotMatch(
      source,
      /event: 'message\.(new|reply)'/,
      `${path} must not build a message announcement payload of its own`,
    )
  }
})
