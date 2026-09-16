import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { channelRoomControls } from '../src/components/features/channels/channel-room-controls'
import { teamsForProjectCreation } from '../src/components/shared/CreateProjectDialog'
import type { TeamRecord } from '../src/lib/api-client'

/**
 * Doorways to changing a channel or placing a project follow the server's
 * answer, not a guess from the channel's type or the organisation's team list:
 * a gear that opens settings the server refuses, or a team the create call
 * refuses, is a control that only produces an error.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

const room = (overrides: Partial<Parameters<typeof channelRoomControls>[0]['activeChannel'] & object> = {}) => ({
  memberRole: 'member' as const,
  type: 'standard' as const,
  viewerCanManage: true,
  viewerIsMember: true,
  visibility: 'public' as const,
  ...overrides,
})

test('the settings gear is offered only to somebody the server lets change the room', () => {
  assert.equal(
    channelRoomControls({ activeChannel: room(), isPersonalAssistantConversation: false }).canManageChannel,
    true,
  )
  // An unjoined public channel is readable and joinable, not manageable.
  const unjoined = channelRoomControls({
    activeChannel: room({ memberRole: null, viewerCanManage: false, viewerIsMember: false }),
    isPersonalAssistantConversation: false,
  })
  assert.equal(unjoined.canManageChannel, false)
  assert.equal(unjoined.shouldJoin, true)
  // A direct message never shows the room gear, whatever the flag says.
  assert.equal(
    channelRoomControls({ activeChannel: room({ type: 'dm' }), isPersonalAssistantConversation: false })
      .canManageChannel,
    false,
  )
})

test('the header and the settings dialog both read viewerCanManage', () => {
  assert.match(source('components/features/channels/ChannelHeader.tsx'), /channelRoomControls\(/)
  assert.match(source('components/shared/ChannelSettingsDialog.tsx'), /if \(!channel\.viewerCanManage\) return null/)
})

const team = (id: string, viewerIsMember?: boolean): TeamRecord => ({
  callProvider: 'jitsi',
  createdAt: '2026-09-14T00:00:00.000Z',
  id,
  name: `Team ${id}`,
  projectId: '00000000-0000-4000-8000-000000000001',
  ...(viewerIsMember === undefined ? {} : { viewerIsMember }),
}) as TeamRecord

test('a member is offered only the teams they are in; an organisation admin every team', () => {
  const teams = [team('a', true), team('b', false), team('c')]
  assert.deepEqual(teamsForProjectCreation(teams, false).map((row) => row.id), ['a'])
  assert.deepEqual(teamsForProjectCreation(teams, true).map((row) => row.id), ['a', 'b', 'c'])
})

test('the create-project and project-members dialogs render the server’s refusal', () => {
  const create = source('components/shared/CreateProjectDialog.tsx')
  assert.match(create, /catch \(error\)/)
  assert.match(create, /role="alert"/)
  const members = source('components/shared/ProjectMembersDialog.tsx')
  assert.match(members, /addMember\.error \?\? removeMember\.error/)
  assert.match(members, /role="alert"/)
})


/**
 * Management is not participation — decision 2 of the visibility spec, and the
 * one rule the composer carries.
 *
 * `canPost` is membership and nothing else. These cases pin the awkward
 * combination in the middle: somebody who may change a room and may not speak
 * in it. If `canPost` is ever re-derived from `viewerCanManage`, the admin case
 * below flips and this fails.
 */
test('an organisation admin managing a room they never joined gets no composer', () => {
  const managing = channelRoomControls({
    // What the server sends an admin on a protected room: the full record, with
    // management authority and `viewerIsMember: false`.
    activeChannel: room({
      memberRole: null,
      viewerCanManage: true,
      viewerIsMember: false,
      visibility: 'protected',
    }),
    isPersonalAssistantConversation: false,
  })
  assert.equal(managing.canManageChannel, true, 'they administer the room')
  assert.equal(managing.canPost, false, 'and still cannot speak in it')
  assert.equal(managing.postRefusal, 'not-a-member')
  // Protected is not self-service, so no Join is offered either.
  assert.equal(managing.shouldJoin, false)
})

test('a public room the viewer has not joined offers Join instead of a composer', () => {
  const browsing = channelRoomControls({
    activeChannel: room({ memberRole: null, viewerCanManage: false, viewerIsMember: false }),
    isPersonalAssistantConversation: false,
  })
  assert.equal(browsing.canPost, false)
  assert.equal(browsing.postRefusal, 'join-to-post')
  assert.equal(browsing.shouldJoin, true)
})

test('a member of the room, and the assistant home, both post', () => {
  assert.equal(
    channelRoomControls({ activeChannel: room(), isPersonalAssistantConversation: false }).canPost,
    true,
  )
  // Reaching a DM or the assistant's own home IS the membership check, made
  // server-side, so neither is gated on the room flag here.
  assert.equal(
    channelRoomControls({
      activeChannel: room({ type: 'dm', viewerIsMember: false }),
      isPersonalAssistantConversation: false,
    }).canPost,
    true,
  )
  assert.equal(
    channelRoomControls({
      activeChannel: room({ viewerIsMember: false }),
      isPersonalAssistantConversation: true,
    }).canPost,
    true,
  )
})

test('the conversation surface renders the composer behind canPost', () => {
  const surface = source('pages/channels/ChannelConversationSurface.tsx')
  // The render condition itself, not merely a mention of the field: the
  // composer must be inside a `canPost` branch rather than beside one.
  assert.match(surface, /visibleActiveTab === 'messages' && roomControls\.canPost \? \(\s*<ChannelComposer/)
  // …and the refusal is drawn in its place, so a person is told why rather
  // than shown a room with no way to type in it.
  assert.match(surface, /visibleActiveTab === 'messages' && !roomControls\.canPost/)
})
