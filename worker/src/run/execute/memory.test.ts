import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import { createConsumedSourceSink } from './disclosure-basis.js'
import {
  admitRememberedThoughtLineage,
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
// project-write floor; every other run keeps the recall it had.
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
