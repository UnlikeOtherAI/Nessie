import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BROWSER_ACT_TOOL_ID,
  BROWSER_OPEN_TOOL_ID,
  EMAIL_SEND_TOOL_ID,
} from '@nessie/runtime'

import {
  computeReplyBasis,
  createConsumedSourceSink,
  type BasisScope,
} from './disclosure-basis.js'
import { persistCurrentRunBasis } from './agent-message.js'
import {
  admitTriggerMessageLineage,
  markUnknownPrivateConversationChannels,
  markUnknownPrivateConversationScopes,
} from './private-conversation-lineage.js'
import { blocksPrivateConversationWrite } from './private-conversation-write-gate.js'

const DESTINATION = {
  channelId: 'channel-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: 'team-1',
}

const scope = (scopeType: string, scopeId: string): BasisScope => ({ scopeId, scopeType })

test('sink de-duplicates repeated sources', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('project', 'project-2'))
  sink.add(scope('project', 'project-2'))
  sink.addAll([scope('project', 'project-2'), scope('team', 'team-9')])

  assert.equal(sink.size(), 2)
  assert.deepEqual(sink.list(), [
    scope('project', 'project-2'),
    scope('team', 'team-9'),
  ])
})

test('sink ignores empty scope type or id', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('', 'project-2'))
  sink.add(scope('project', ''))

  assert.equal(sink.size(), 0)
})

test('sink keeps same-id sources under different audience types apart', () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('project', 'shared-id'))
  sink.add(scope('team', 'shared-id'))

  assert.equal(sink.size(), 2)
})

test('a run persists its source basis before any derived metadata is written', async () => {
  const sink = createConsumedSourceSink()
  sink.add(scope('user', 'author-b'))
  const writes: Array<{ data: { runId: string; scopeId: string; scopeType: string }[] }> = []

  await persistCurrentRunBasis({
    runBasisScope: {
      createMany: async (input: { data: { runId: string; scopeId: string; scopeType: string }[] }) => {
        writes.push(input)
        return { count: input.data.length }
      },
    },
  } as never, {
    boundAgentIds: [],
    channel: DESTINATION,
    consumedSources: sink,
    run: { id: 'run-1' },
  } as never)

  assert.deepEqual(writes[0]?.data, [{
    organizationId: DESTINATION.organizationId,
    runId: 'run-1',
    scopeId: 'author-b',
    scopeType: 'user',
  }])
})

test('private source lineage retains an unknown-author denial marker', () => {
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({
    sourceAuthorUserId: 'author-b',
    sourceChannelId: 'private-room',
  })
  sink.addPrivateConversationSource({
    sourceAuthorUserId: null,
    sourceChannelId: 'private-room',
  })

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' },
    { sourceAuthorUserId: null, sourceChannelId: 'private-room' },
  ])
  assert.deepEqual(sink.list(), [scope('channel', 'private-room')])
})

test('checkpoint or memory channel provenance cannot be re-attributed by a later author', async () => {
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({
    sourceAuthorUserId: 'author-b',
    sourceChannelId: 'private-room',
  })

  await markUnknownPrivateConversationScopes(
    { channel: { findMany: async () => [{ id: 'private-room' }] } } as never,
    sink,
    [scope('channel', 'private-room')],
  )

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' },
    { sourceAuthorUserId: null, sourceChannelId: 'private-room' },
  ])
})

test('a deleted private source channel remains an unknown denial marker', async () => {
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({
    sourceAuthorUserId: 'author-b',
    sourceChannelId: 'still-present-private-room',
  })

  await markUnknownPrivateConversationScopes(
    { channel: { findMany: async () => [] } } as never,
    sink,
    [scope('channel', 'deleted-private-room')],
  )

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'still-present-private-room' },
    { sourceAuthorUserId: null, sourceChannelId: 'deleted-private-room' },
  ])
  assert.equal(
    blocksPrivateConversationWrite({
      context: { agent: { agentKind: 'shared' }, consumedSources: sink } as never,
      isExternal: true,
      toolName: 'mcp_publish',
    }),
    true,
  )
})

test('a delegated trigger keeps its original private author without adding an unknown marker', async () => {
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage(
    { channel: { findMany: async () => [] } } as never,
    sink,
    {
      agentId: null, metadata: null, onBehalfOfUserId: null, role: 'system', userId: null,
      thread: { channel: { id: 'destination', visibility: 'private' } },
      basisScopes: [scope('channel', 'private-room')],
      disclosureSources: [{ sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' }],
    },
  )

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' },
  ])
  assert.equal(
    blocksPrivateConversationWrite({
      context: {
        agent: { agentKind: 'shared' },
        consumedSources: sink,
      } as unknown as import('./types.js').RunContext,
      isExternal: true,
      toolName: 'mcp_publish',
    }),
    true,
  )
})

test('a legacy delegated trigger becomes an unknown private source', async () => {
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage(
    { channel: { findMany: async () => [{ id: 'private-room', visibility: 'private' }] } } as never,
    sink,
    {
      agentId: null, metadata: null, onBehalfOfUserId: null, role: 'system', userId: null,
      thread: { channel: { id: 'destination', visibility: 'private' } },
      basisScopes: [scope('channel', 'private-room')], disclosureSources: [],
    },
  )

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: null, sourceChannelId: 'private-room' },
  ])
})

test('an old private human trigger keeps its own author independently of the later transcript', async () => {
  const sink = createConsumedSourceSink()
  // The latest transcript contains only a later speaker. The waiting trigger
  // is already outside that window, so only its explicit admission records A.
  sink.addPrivateConversationSource({ sourceAuthorUserId: 'later-author', sourceChannelId: 'private-room' })
  await admitTriggerMessageLineage({} as never, sink, {
    agentId: null, metadata: null, onBehalfOfUserId: null, role: 'user', userId: 'original-author',
    thread: { channel: { id: 'private-room', visibility: 'protected' } },
    basisScopes: [], disclosureSources: [],
  })
  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'later-author', sourceChannelId: 'private-room' },
    { sourceAuthorUserId: 'original-author', sourceChannelId: 'private-room' },
  ])
})

test('a user-shaped delegated trigger never treats its effective person as the original author', async () => {
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage({} as never, sink, {
    agentId: null, metadata: { delegatedByAgentId: 'agent-1' }, onBehalfOfUserId: null,
    role: 'user', userId: 'effective-user',
    thread: { channel: { id: 'private-room', visibility: 'private' } },
    basisScopes: [], disclosureSources: [],
  })
  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: null, sourceChannelId: 'private-room' },
  ])
})

test('a public human trigger adds no private source and retains inherited source restrictions', async () => {
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage({} as never, sink, {
    agentId: null, metadata: null, onBehalfOfUserId: null, role: 'user', userId: 'public-author',
    thread: { channel: { id: 'public-room', visibility: 'public' } },
    basisScopes: [],
    disclosureSources: [{ sourceAuthorUserId: 'private-author', sourceChannelId: 'private-room' }],
  })
  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'private-author', sourceChannelId: 'private-room' },
  ])
})

test('a saved classifier input keeps older authors and personal restrictions outside the transcript', async () => {
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage({} as never, sink, {
    agentId: null, metadata: null, onBehalfOfUserId: null, role: 'user', userId: 'trigger-author',
    thread: { channel: { id: 'private-room', visibility: 'protected' } },
    basisScopes: [], disclosureSources: [],
    channelDecision: {
      decisions: [], policyFingerprint: 'saved',
      basisScopes: [{ scopeType: 'user', scopeId: 'document-owner' }],
      disclosureSources: [{ sourceAuthorUserId: 'older-author', sourceChannelId: 'private-room' }],
    },
  })
  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'trigger-author', sourceChannelId: 'private-room' },
    { sourceAuthorUserId: 'older-author', sourceChannelId: 'private-room' },
  ])
  assert.ok(sink.list().some((scope) => scope.scopeType === 'user' && scope.scopeId === 'document-owner'))
})

test('a malformed saved classifier lineage refuses prompt admission', async () => {
  await assert.rejects(admitTriggerMessageLineage({} as never, createConsumedSourceSink(), {
    agentId: null, metadata: null, onBehalfOfUserId: null, role: 'user', userId: 'trigger-author',
    thread: { channel: { id: 'public-room', visibility: 'public' } },
    basisScopes: [], disclosureSources: [], channelDecision: { decisions: [] },
  }))
})

test('private conversation material reaches only the disclosure-stamped knowledge writers', () => {
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({ sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' })
  const context = {
    agent: { agentKind: 'shared' },
    consumedSources: sink,
  } as unknown as import('./types.js').RunContext

  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: false, toolName: 'kb_draft_write' }),
    false,
  )
  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: true, toolName: 'mcp_publish' }),
    true,
  )
  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: false, toolName: 'send_message' }),
    false,
  )
  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: false, toolName: EMAIL_SEND_TOOL_ID }),
    true,
  )
  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: false, toolName: BROWSER_OPEN_TOOL_ID }),
    true,
    'a shared agent cannot put private text into a browser URL',
  )
  assert.equal(
    blocksPrivateConversationWrite({ context, isExternal: false, toolName: BROWSER_ACT_TOOL_ID }),
    true,
    'a shared agent cannot type private text into a browser page',
  )
  assert.equal(
    blocksPrivateConversationWrite({
      context: {
        ...context,
        consumedSources: createConsumedSourceSink(),
      },
      isExternal: false,
      toolName: BROWSER_ACT_TOOL_ID,
    }),
    false,
    'a public-context shared run remains allowed to use browser actions',
  )
  assert.equal(
    blocksPrivateConversationWrite({
      context: { ...context, agent: { ...context.agent, agentKind: 'personal_assistant' } },
      isExternal: false,
      toolName: 'kb_draft_write',
    }),
    false,
  )
  assert.equal(
    blocksPrivateConversationWrite({
      context: { ...context, agent: { ...context.agent, agentKind: 'personal_assistant' } },
      isExternal: true,
      toolName: 'mcp_publish',
    }),
    false,
  )
})

test('a private attachment source remains unknown beside a current human turn', () => {
  const sink = createConsumedSourceSink()
  sink.addPrivateConversationSource({ sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' })
  markUnknownPrivateConversationChannels(sink, [{ id: 'private-room', visibility: 'private' }])

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'private-room' },
    { sourceAuthorUserId: null, sourceChannelId: 'private-room' },
  ])
})

test('a run consuming only destination-implied sources has an empty basis', () => {
  const basis = computeReplyBasis(
    [
      scope('organization', 'org-1'),
      scope('project', 'project-1'),
      scope('team', 'team-1'),
      scope('channel', 'channel-1'),
    ],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [])
})

test('a source the destination does not imply becomes the basis', () => {
  const basis = computeReplyBasis(
    [scope('organization', 'org-1'), scope('project', 'project-2')],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [scope('project', 'project-2')])
})

test('user-private sources are never implied by a destination', () => {
  const basis = computeReplyBasis([scope('user', 'user-1')], DESTINATION, [])

  assert.deepEqual(basis, [scope('user', 'user-1')])
})

test('a foreign organization is not implied', () => {
  const basis = computeReplyBasis([scope('organization', 'org-2')], DESTINATION, [])

  assert.deepEqual(basis, [scope('organization', 'org-2')])
})

test('implication compares the (type, id) pair, not the id alone', () => {
  // A project whose id equals the destination team's id is still privileged.
  const basis = computeReplyBasis([scope('project', 'team-1')], DESTINATION, [])

  assert.deepEqual(basis, [scope('project', 'team-1')])
})

test('the basis de-duplicates repeated privileged sources', () => {
  const basis = computeReplyBasis(
    [scope('project', 'project-2'), scope('project', 'project-2')],
    DESTINATION,
    [],
  )

  assert.deepEqual(basis, [scope('project', 'project-2')])
})

test('consuming nothing yields an empty basis', () => {
  assert.deepEqual(computeReplyBasis([], DESTINATION, []), [])
})

test('a bound agent is implied by the destination channel', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'agent-1')], DESTINATION, ['agent-1']),
    [],
  )
})

test('an unbound agent remains in the reply basis', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'agent-1')], DESTINATION, ['agent-2']),
    [scope('agent', 'agent-1')],
  )
})

test('a child reading its bound parent\'s documents has an unrestricted reply', () => {
  assert.deepEqual(
    computeReplyBasis([scope('agent', 'parent-agent')], DESTINATION, ['parent-agent']),
    [],
  )
})
