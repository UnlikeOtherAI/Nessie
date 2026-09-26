import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import { createConsumedSourceSink } from './disclosure-basis.js'
import {
  admitRememberedThoughtLineage,
  readsRoomHistoryAsRoom,
  recallLineageGate,
  retainThoughtsWithLineage,
  requiresMemoryDestinationContainment,
  requiresProjectWriteRecallContainment,
  thoughtLineageScopes,
} from './memory.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

test('a PA in a shared channel is memory-contained while its PA DM is not', () => {
  assert.equal(
    requiresMemoryDestinationContainment({
      agentKind: 'personal_assistant',
      organizationId: ORG,
      systemChannelType: null,
    }, true),
    true,
  )
  assert.equal(
    requiresMemoryDestinationContainment({
      agentKind: 'personal_assistant',
      organizationId: ORG,
      systemChannelType: 'personal_assistant',
    }, true),
    false,
  )
})

test('a global agent in its own home DM is exempt, and contained everywhere else', () => {
  const home = {
    agentKind: 'shared' as const,
    dmKey: globalAgentHomeDmKey({
      organizationId: ORG,
      slug: AGENT_DESIGNER_SLUG,
      userId: USER,
    }),
    organizationId: ORG,
    systemChannelType: 'system_agent',
    systemSlug: AGENT_DESIGNER_SLUG,
  }
  assert.equal(requiresMemoryDestinationContainment(home, true), false)

  // Same agent, ordinary channel: contained like any shared-room destination.
  assert.equal(
    requiresMemoryDestinationContainment({
      ...home,
      dmKey: null,
      systemChannelType: null,
    }, true),
    true,
  )

  // Another organisation's home key never satisfies this organisation's prefix.
  assert.equal(
    requiresMemoryDestinationContainment({
      ...home,
      organizationId: '33333333-3333-4333-8333-333333333333',
    }, true),
    true,
  )
})

test('an ordinary shared agent is contained even in a system_agent DM', () => {
  assert.equal(
    requiresMemoryDestinationContainment({
      agentKind: 'shared',
      dmKey: globalAgentHomeDmKey({
        organizationId: ORG,
        slug: AGENT_DESIGNER_SLUG,
        userId: USER,
      }),
      organizationId: ORG,
      systemChannelType: 'system_agent',
      systemSlug: null,
    }, true),
    true,
  )
})

test('remembered private thoughts retain B and preserve a legacy unknown source', async () => {
  const sink = createConsumedSourceSink()
  await admitRememberedThoughtLineage(
    {
      channel: {
        findMany: async () => [{ id: 'private-channel', visibility: 'private' }],
      },
    } as never,
    sink,
    [
      {
        audienceId: 'private-channel',
        audienceType: 'channel',
        sources: [{ sourceAuthorUserId: USER, sourceChannelId: 'private-channel' }],
        thoughtId: 'remembered-with-author',
      },
      {
        audienceId: 'private-channel',
        audienceType: 'channel',
        sources: [],
        thoughtId: 'legacy-without-author',
      },
    ],
  )

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: USER, sourceChannelId: 'private-channel' },
    { sourceAuthorUserId: null, sourceChannelId: 'private-channel' },
  ])
})

test('a recalled thought without complete durable lineage is excluded from model context', () => {
  const recalled = [
    { id: 'retained' },
    { id: 'deleted-after-search' },
    { id: 'legacy-without-audience' },
  ]
  const retained = retainThoughtsWithLineage(recalled, [{
    audienceId: 'private-channel',
    audienceType: 'channel',
    sources: [],
    thoughtId: 'retained',
  }, {
    audienceId: null,
    audienceType: null,
    sources: [],
    thoughtId: 'legacy-without-audience',
  }])

  assert.deepEqual(retained, [{ id: 'retained' }])
})

// F16: a contained run lent a project write recalls under the narrower
// project-write floor.
const projectChannelRun = {
  agentKind: 'shared' as const,
  dmKey: null,
  organizationId: ORG,
  systemChannelType: null,
  systemSlug: null,
}

test('project-write recall containment needs both containment and a lent write', () => {
  assert.equal(requiresProjectWriteRecallContainment(projectChannelRun, true, true), true)
  assert.equal(requiresProjectWriteRecallContainment(projectChannelRun, false, true), false)
  // Containment switched off by deployment: nothing narrows, as before.
  assert.equal(requiresProjectWriteRecallContainment(projectChannelRun, true, false), false)
  // A delegate in its own home is not contained, so its recall is untouched.
  assert.equal(requiresProjectWriteRecallContainment({
    ...projectChannelRun,
    dmKey: globalAgentHomeDmKey({ organizationId: ORG, slug: AGENT_DESIGNER_SLUG, userId: USER }),
    systemChannelType: 'system_agent',
    systemSlug: AGENT_DESIGNER_SLUG,
  }, true, true), false)
})

test('a thought\'s lineage scopes are its audience plus every private conversation it came from', () => {
  assert.deepEqual(thoughtLineageScopes({
    audienceId: ORG,
    audienceType: 'organization',
    sources: [{ sourceAuthorUserId: USER, sourceChannelId: 'dm-1' }],
    thoughtId: 'thought-1',
  }), [
    { scopeId: ORG, scopeType: 'organization' },
    { scopeId: 'dm-1', scopeType: 'channel' },
  ])
  assert.deepEqual(thoughtLineageScopes({
    audienceId: null,
    audienceType: null,
    sources: [],
    thoughtId: 'legacy',
  }), [])
})

// A scheduled joke in a public room recalled its owner's DM with the agent and
// was withheld from everyone else there. Recall may not be what restricts a
// contained run's reply; what the room already implies is still recalled.
const PROJECT = '44444444-4444-4444-8444-444444444444'
const TEAM = '55555555-5555-4555-8555-555555555555'
const ROOM = '66666666-6666-4666-8666-666666666666'
const AGENT = '77777777-7777-4777-8777-777777777777'
const DM = '88888888-8888-4888-8888-888888888888'

const roomRun = (sink = createConsumedSourceSink()) => ({
  boundAgentIds: [AGENT],
  channel: { id: ROOM, organizationId: ORG, projectId: PROJECT, teamId: TEAM },
  consumedSources: sink,
  emailMailboxId: null,
})

test('a contained room recalls only what adds nothing to its reply basis', () => {
  const gate = recallLineageGate(projectChannelRun, roomRun() as never, false, true)
  assert.ok(gate)
  for (const implied of [
    { scopeId: ORG, scopeType: 'organization' },
    { scopeId: PROJECT, scopeType: 'project' },
    { scopeId: TEAM, scopeType: 'team' },
    { scopeId: ROOM, scopeType: 'channel' },
    { scopeId: AGENT, scopeType: 'agent' },
  ]) assert.equal(gate([implied]), true, `${implied.scopeType} is implied by the room`)
  assert.equal(gate([]), true)
  // The owner's DM with the agent is theirs alone.
  assert.equal(gate([{ scopeId: ORG, scopeType: 'organization' }, { scopeId: DM, scopeType: 'channel' }]), false)
  assert.equal(gate([{ scopeId: USER, scopeType: 'user' }]), false)

  // Once the reply already carries that conversation, recalling more of it
  // changes no one's access, so it is taken.
  const holding = createConsumedSourceSink()
  holding.addPrivateConversationSource({ sourceAuthorUserId: USER, sourceChannelId: DM })
  const heldGate = recallLineageGate(projectChannelRun, roomRun(holding) as never, false, true)
  assert.equal(heldGate?.([{ scopeId: DM, scopeType: 'channel' }]), true)
})

test('a lent project write keeps its narrower floor, and a delegate home judges nothing', () => {
  const gate = recallLineageGate(projectChannelRun, roomRun() as never, true, true)
  assert.equal(gate?.([{ scopeId: PROJECT, scopeType: 'project' }]), true)
  // The room's own channel is implied for a reply, never for a board write.
  assert.equal(gate?.([{ scopeId: ROOM, scopeType: 'channel' }]), false)

  const home = {
    ...projectChannelRun,
    dmKey: globalAgentHomeDmKey({ organizationId: ORG, slug: AGENT_DESIGNER_SLUG, userId: USER }),
    systemChannelType: 'system_agent',
    systemSlug: AGENT_DESIGNER_SLUG,
  }
  assert.equal(recallLineageGate(home, roomRun() as never, false, true), null)
  // Containment switched off by deployment: nothing is judged.
  assert.equal(recallLineageGate(projectChannelRun, roomRun() as never, false, false), null)
})

test('a run no person is live in reads its room as the room does', () => {
  // A schedule, event trigger or channel policy acting on a saved authority.
  assert.equal(readsRoomHistoryAsRoom(projectChannelRun, false, true), true)
  // A live requester continues their own conversation, restricted or not.
  assert.equal(readsRoomHistoryAsRoom(projectChannelRun, true, true), false)
  // A delegate in its own home is that person's estate.
  assert.equal(readsRoomHistoryAsRoom({
    agentKind: 'personal_assistant',
    organizationId: ORG,
    systemChannelType: 'personal_assistant',
  }, false, true), false)
  assert.equal(readsRoomHistoryAsRoom(projectChannelRun, false, false), false)
})
