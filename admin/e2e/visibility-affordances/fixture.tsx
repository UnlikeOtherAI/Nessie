import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import {
  channelRoomControls,
} from '../../src/components/features/channels/channel-room-controls'
import {
  ChannelGlyph,
  ProjectLockMarker,
} from '../../src/components/shared/RoomVisibilityGlyph'
import { channelHashClassName } from '../../src/layouts/admin-shell/SidebarRow'
import type { ChannelRecord } from '../../src/lib/api-client'
import '../../src/styles.css'

/**
 * What a person actually sees when a room is protected, and when they are
 * outside one.
 *
 * Two rules are drawn here, and both are invisible in a unit test:
 *
 * 1. **The lock is derived from `visibility`.** There is no `locked` field on
 *    the wire, so every surface has to reach the same conclusion from the same
 *    value. `ChannelGlyph` replaces the `#` in a sidebar row; `ProjectLockMarker`
 *    sits beside a project's name. A public room gets neither.
 * 2. **Management is not participation.** `channelRoomControls` decides the
 *    composer on membership alone, so an organisation admin administering a
 *    room they never joined is shown the settings and told they cannot post.
 *    The awkward middle case — may change the room, may not speak in it — is
 *    the one worth being able to look at.
 *
 * No database and no API: the real derivations run over hand-built records, so
 * the fixture is a picture of the rules rather than of a seeded fixture's data.
 */

type Case = {
  id: string
  label: string
  channel: Pick<
    ChannelRecord,
    'memberRole' | 'type' | 'viewerCanManage' | 'viewerIsMember' | 'visibility'
  >
  note: string
}

const CASES: Case[] = [
  {
    channel: {
      memberRole: 'member',
      type: 'standard',
      viewerCanManage: true,
      viewerIsMember: true,
      visibility: 'public',
    },
    id: 'member',
    label: 'A member of a public room',
    note: 'Writes, and manages.',
  },
  {
    channel: {
      memberRole: null,
      type: 'standard',
      viewerCanManage: false,
      viewerIsMember: false,
      visibility: 'public',
    },
    id: 'browsing',
    label: 'Browsing a public room they have not joined',
    note: 'Reads. Joining is self-service.',
  },
  {
    channel: {
      memberRole: null,
      type: 'standard',
      viewerCanManage: true,
      viewerIsMember: false,
      visibility: 'protected',
    },
    id: 'admin-outside',
    label: 'An organisation admin outside a protected room',
    note: 'Administers it. Cannot speak in it.',
  },
]

const Row = ({ item }: { item: Case }) => {
  const controls = channelRoomControls({
    activeChannel: item.channel,
    isPersonalAssistantConversation: false,
  })
  return (
    <li
      className="grid gap-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] p-4"
      data-testid={`case-${item.id}`}
    >
      <div className="flex items-center gap-2">
        <ChannelGlyph className={channelHashClassName} visibility={item.channel.visibility} />
        <span className="text-sm font-semibold text-[color:var(--tx)]">{item.label}</span>
      </div>
      <p className="text-xs text-[color:var(--tx3)]">{item.note}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <span data-testid={`${item.id}-manage`}>
          Settings: {controls.canManageChannel ? 'shown' : 'hidden'}
        </span>
        <span data-testid={`${item.id}-join`}>
          Join: {controls.shouldJoin ? 'shown' : 'hidden'}
        </span>
        <span data-testid={`${item.id}-post`}>
          Composer: {controls.canPost ? 'shown' : 'hidden'}
        </span>
      </div>
      {controls.canPost ? (
        <div className="rounded-lg border border-[color:var(--sep)] px-3 py-2 text-sm text-[color:var(--tx3)]">
          Message #room
        </div>
      ) : (
        <div
          className="border-t border-[color:var(--bd)] px-1 py-2 text-xs text-[color:var(--tx3)]"
          data-testid={`${item.id}-refusal`}
          role="status"
        >
          {controls.postRefusal === 'join-to-post'
            ? 'Join this channel to send messages.'
            : 'You are not a member of this channel, so you cannot send messages in it.'}
        </div>
      )}
    </li>
  )
}

const Fixture = () => {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return (
    <div
      className="grid gap-4 p-4"
      data-ready={ready ? 'true' : 'false'}
      style={{ background: 'var(--bg)', minHeight: '100vh' }}
    >
      <ul className="grid gap-3">
        {CASES.map((item) => <Row item={item} key={item.id} />)}
      </ul>
      <div className="grid gap-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] p-4">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          Projects
        </span>
        <span className="flex items-center gap-1.5" data-testid="project-protected">
          <ProjectLockMarker visibility="protected" />
          <span className="text-sm text-[color:var(--tx)]">Launch — protected</span>
        </span>
        <span className="flex items-center gap-1.5" data-testid="project-public">
          <ProjectLockMarker visibility="public" />
          <span className="text-sm text-[color:var(--tx)]">Marketing — public</span>
        </span>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
