import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_OPEN_TOOL_ID } from '@nessie/runtime'

import { loadFreshPrivateImportTarget } from '../src/routes/browser-cookie-imports.js'

type AccessState = {
  agentKind: 'personal_assistant' | 'shared'
  binding: number
  connection: number
  dmKey: string
  membership: number
  ownerUserId: string | null
  systemChannelType: 'personal_assistant' | 'system_agent' | null
  systemManaged: boolean
  systemSlug: string | null
  thread: boolean
  toolGranted: boolean
  visibility: 'private' | 'team'
}

const state = (): AccessState => ({
  agentKind: 'shared',
  binding: 1,
  connection: 1,
  dmKey: 'agent:org-1:user-1:agent-1',
  membership: 1,
  ownerUserId: 'user-1',
  systemChannelType: null,
  systemManaged: false,
  systemSlug: null,
  thread: true,
  toolGranted: true,
  visibility: 'private',
})

const prismaFor = (access: AccessState) => ({
  agent: {
    findFirst: async () => ({
      agentKind: access.agentKind,
      id: 'agent-1',
      name: 'Private agent',
      ownerUserId: access.ownerUserId,
      systemManaged: access.systemManaged,
      systemSlug: access.systemSlug,
      toolPolicy: { [BROWSER_OPEN_TOOL_ID]: access.toolGranted },
      visibility: access.visibility,
    }),
  },
  agentBinding: {
    count: async (input: { where: { principalUserId: string | null } }) =>
      input.where.principalUserId === null ? access.binding : 0,
  },
  channelMember: { count: async () => 1 },
  cloudBrowserConnection: { count: async () => access.connection },
  organizationMember: { count: async () => access.membership },
  thread: {
    findFirst: async () => access.thread
      ? {
        channel: {
          _count: { members: 1 },
          dmKey: access.dmKey,
          id: 'channel-1',
          systemChannelType: access.systemChannelType,
          type: 'dm',
          visibility: 'private',
        },
      }
      : null,
  },
})

const targetFor = (access: AccessState) => loadFreshPrivateImportTarget(prismaFor(access) as never, {
  agentId: 'agent-1',
  organizationId: 'org-1',
  threadId: 'thread-1',
  userId: 'user-1',
})

test('private import target needs the actor’s live private home and personal connection', async () => {
  assert.deepEqual(await targetFor(state()), {
    agentName: 'Private agent',
    agentOwnerUserId: 'user-1',
  })
})

test('membership, private-home binding, browser grant, and personal connection are rechecked', async () => {
  for (const mutate of [
    (access: AccessState) => { access.membership = 0 },
    (access: AccessState) => { access.binding = 0 },
    (access: AccessState) => { access.connection = 0 },
    (access: AccessState) => { access.toolGranted = false },
    (access: AccessState) => { access.thread = false },
  ]) {
    const access = state()
    mutate(access)
    assert.equal(await targetFor(access), null)
  }
})

test('a system-managed agent is allowed only through the actor’s exact personal DM binding', async () => {
  const access = state()
  access.agentKind = 'personal_assistant'
  access.dmKey = 'pa:org-1:user-1'
  access.ownerUserId = null
  access.systemManaged = true
  access.systemChannelType = 'personal_assistant'
  access.visibility = 'team'
  assert.ok(await targetFor(access))

  access.binding = 0
  assert.equal(await targetFor(access), null)
})

test('a system-managed global agent needs its own canonical one-person home', async () => {
  const access = state()
  access.agentKind = 'shared'
  access.dmKey = 'gagent:agent-designer:org-1:user-1'
  access.ownerUserId = null
  access.systemChannelType = 'system_agent'
  access.systemManaged = true
  access.systemSlug = 'agent-designer'
  access.visibility = 'team'
  assert.ok(await targetFor(access))

  access.dmKey = 'gagent:agent-designer:org-1:user-2'
  assert.equal(await targetFor(access), null)
})

test('private-home authorization rejects a PA presence and lookalike DM', async () => {
  const access = state()
  access.dmKey = 'some-private-channel'
  assert.equal(await targetFor(access), null)

  access.dmKey = 'agent:org-1:user-1:agent-1'
  access.agentKind = 'personal_assistant'
  access.ownerUserId = null
  access.systemManaged = true
  access.systemChannelType = null
  assert.equal(await targetFor(access), null)
})
