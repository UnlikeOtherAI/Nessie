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
    activeChannel: room({ memberRole: null, viewerCanManage: false }),
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
