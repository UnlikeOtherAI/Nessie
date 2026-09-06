import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ChannelRecord, MeResponse, UserRecord } from '../../../lib/api-client'
import { getConversationRoute } from '../../../lib/conversation-navigation'
import { usePhoneLayout } from '../../../navigation/mobile-shell'
import { useAddChannelMember, useRemoveChannelMember, useSetChannelMute } from '../../../facades/channels/hooks'
import { AvailableUserRow, CurrentUserRow } from '../../shared/channel-members/MemberUserRow'
import { ScreenHeader } from '../../shared/ScreenHeader'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { UserAvatar } from '../../shared/UserAvatar'
import { IdentityTile } from '../../primitives/IdentityTile'
import { RAIL_POLL_MS, useThreadBrowserSessions } from '../../../facades/browser-cloud/hooks'
import { CHAT_TOOLS, type ChatToolId } from './tool-rail/chat-tools'

type ConversationInfoFlowProps = {
  activeChannel: ChannelRecord
  /** The open thread, so the drawer can offer any live agent browser in it. */
  activeThreadId: string | null
  allUsers: UserRecord[]
  canAddPeople: boolean
  channelUsers: UserRecord[]
  /** This conversation has one agent, so the agent's tools apply to it. */
  hasAgentTools: boolean
  me: MeResponse
  onGroupCreated: (channelId: string) => void
  onOpenTool: (tool: ChatToolId) => void
}

const matchPerson = (person: UserRecord, query: string): boolean => {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return `${person.displayName} ${person.email}`.toLocaleLowerCase().includes(normalized)
}

const Disclosure = ({
  detail,
  label,
  onClick,
}: {
  detail?: string
  label: string
  onClick: () => void
}) => (
  <button
    className="flex w-full items-center gap-3 border-b border-[color:var(--sep)] px-5 py-4 text-left transition-colors hover:bg-[color:var(--overlay-weak)]"
    onClick={onClick}
    type="button"
  >
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-semibold text-[color:var(--tx)]">{label}</span>
      {detail ? <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">{detail}</span> : null}
    </span>
    <svg aria-hidden="true" className="h-5 w-5 flex-shrink-0 text-[color:var(--tx3)]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
)

/**
 * The agent's tools on a single-column layout, where the rail beside the chat
 * has no room to stand.
 *
 * Same table as the rail (`CHAT_TOOLS`), so a tool is added once and shows up
 * in both doorways — and this is the only doorway a phone has, which is the
 * whole of Rule zero check 1 for this surface. Selecting one closes the info
 * screen and opens the tool over the conversation.
 */
const ChatToolDisclosures = ({
  onOpenTool,
  threadId,
}: {
  onOpenTool: (tool: ChatToolId) => void
  threadId: string | null
}) => {
  const sessions = useThreadBrowserSessions(threadId, { refetchInterval: RAIL_POLL_MS })
  const browsing = (sessions.data?.sessions.length ?? 0) > 0
  return (
    <>
      {CHAT_TOOLS.map((tool) => (
        <Disclosure
          detail={
            tool.id === 'browser' && browsing
              ? 'Browsing now — watch what it sees'
              : tool.description
          }
          key={tool.id}
          label={tool.label}
          onClick={() => onOpenTool(tool.id)}
        />
      ))}
    </>
  )
}

const ConversationOverview = ({
  activeChannel,
  channelUsers,
  hasAgentTools,
  memberCount,
  canAddPeople,
  onOpenMembers,
  onOpenAddPeople,
  onOpenFiles,
  onOpenMessages,
  onOpenTool,
  threadId,
}: {
  activeChannel: ChannelRecord
  channelUsers: UserRecord[]
  hasAgentTools: boolean
  memberCount: number
  canAddPeople: boolean
  onOpenMembers: () => void
  onOpenAddPeople: () => void
  onOpenFiles: () => void
  onOpenMessages: () => void
  onOpenTool: (tool: ChatToolId) => void
  threadId: string | null
}) => {
  const setMute = useSetChannelMute()
  const isGroup = Boolean(activeChannel.isGroupDm || memberCount > 2)
  const heading = isGroup ? 'Group conversation' : 'Direct message'
  const participantPreview = channelUsers
    .filter((person) => person.id !== activeChannel.dmUserId)
    .slice(0, 3)

  return (
    <>
      <div className="border-b border-[color:var(--sep)] px-5 py-6 text-center">
        <IdentityTile
          background="var(--accent-soft)"
          className="mx-auto"
          color="var(--accent)"
          fallback={{ kind: 'icon', icon: <GroupConversationMark /> }}
          imageUrl={null}
          label={activeChannel.label}
          size={64}
        />
        <p className="mt-3 text-sm font-semibold text-[color:var(--tx)]">{activeChannel.label}</p>
        <p className="mt-1 text-xs text-[color:var(--tx3)]">{heading} · {memberCount} member{memberCount === 1 ? '' : 's'}</p>
        {participantPreview.length > 0 ? (
          <div className="mt-3 flex justify-center -space-x-2">
            {participantPreview.map((person) => (
              <UserAvatar
                avatarAttachmentId={person.avatarAttachmentId ?? undefined}
                avatarUrl={person.avatarUrl ?? undefined}
                className="ring-2 ring-[color:var(--main)]"
                displayName={person.displayName}
                key={person.id}
                size={28}
                token={null}
                userId={person.id}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 border-y border-[color:var(--sep)]">
        {hasAgentTools ? (
          <ChatToolDisclosures onOpenTool={onOpenTool} threadId={threadId} />
        ) : null}
        <Disclosure label="Messages" onClick={onOpenMessages} />
        <Disclosure label="Files and links" onClick={onOpenFiles} />
      </div>

      <div className="mt-3 border-y border-[color:var(--sep)]">
        <Disclosure
          detail={`${memberCount} member${memberCount === 1 ? '' : 's'}`}
          label="Members"
          onClick={onOpenMembers}
        />
        {canAddPeople ? <Disclosure label="Add people" onClick={onOpenAddPeople} /> : null}
        <button
          className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[color:var(--overlay-weak)]"
          disabled={setMute.isPending}
          onClick={() => setMute.mutate({ channelId: activeChannel.id, muted: !activeChannel.muted })}
          type="button"
        >
          <span>
            <span className="block text-sm font-semibold text-[color:var(--tx)]">Notifications</span>
            <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">
              {activeChannel.muted ? 'Muted' : 'All new messages'}
            </span>
          </span>
          <span className="text-xs font-semibold text-[color:var(--accent)]">
            {activeChannel.muted ? 'Turn on' : 'Mute'}
          </span>
        </button>
      </div>
    </>
  )
}

const ConversationMembers = ({
  activeChannel,
  channelUsers,
  currentUserId,
}: {
  activeChannel: ChannelRecord
  channelUsers: UserRecord[]
  currentUserId: string
}) => {
  const removeMember = useRemoveChannelMember()
  const [query, setQuery] = useState('')
  const visibleMembers = useMemo(
    () => channelUsers.filter((person) => matchPerson(person, query)),
    [channelUsers, query],
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-[color:var(--sep)] px-5 py-3">
        <input
          aria-label="Search members"
          className="w-full rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)] px-3 py-2.5 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)] focus:border-[color:var(--accent)]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search members"
          value={query}
        />
      </div>
      <div className="px-3 py-2">
        {visibleMembers.map((person) => (
          <CurrentUserRow
            canRemove={activeChannel.viewerCanManage}
            currentUserId={currentUserId}
            key={person.id}
            onRemove={(userId) => removeMember.mutate({ channelId: activeChannel.id, userId })}
            removeLabel="Remove from channel"
            removePending={removeMember.isPending}
            user={person}
          />
        ))}
        {visibleMembers.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-[color:var(--tx3)]">No members match that search.</p>
        ) : null}
      </div>
    </div>
  )
}

const AddConversationMembers = ({
  activeChannel,
  allUsers,
  channelUsers,
  currentUserId,
  onGroupCreated,
}: {
  activeChannel: ChannelRecord
  allUsers: UserRecord[]
  channelUsers: UserRecord[]
  currentUserId: string
  onGroupCreated: (channelId: string) => void
}) => {
  const addMember = useAddChannelMember()
  const [query, setQuery] = useState('')
  const memberIds = useMemo(() => new Set(channelUsers.map((person) => person.id)), [channelUsers])
  const people = useMemo(
    () => allUsers
      .filter((person) => person.id !== currentUserId && !memberIds.has(person.id))
      .filter((person) => matchPerson(person, query)),
    [allUsers, currentUserId, memberIds, query],
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-[color:var(--sep)] px-5 py-3">
        <input
          autoFocus
          aria-label="Find people to add"
          className="w-full rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)] px-3 py-2.5 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)] focus:border-[color:var(--accent)]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a name or email address"
          value={query}
        />
      </div>
      <p className="px-5 py-3 text-xs text-[color:var(--tx3)]">People already in this conversation are not shown.</p>
      <div className="px-3 pb-4">
        {people.map((person) => (
          <AvailableUserRow
            addPending={addMember.isPending}
            key={person.id}
            onAdd={(userId) => addMember.mutate(
              { channelId: activeChannel.id, userId },
              {
                onSuccess: (channel) => {
                  if (activeChannel.type === 'dm' && channel?.id) onGroupCreated(channel.id)
                },
              },
            )}
            user={person}
          />
        ))}
        {people.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-[color:var(--tx3)]">No people are available to add.</p>
        ) : null}
      </div>
    </div>
  )
}

const GroupConversationMark = () => (
  <svg aria-hidden="true" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const ConversationInfoFlow = ({
  activeChannel,
  activeThreadId,
  allUsers,
  canAddPeople,
  channelUsers,
  hasAgentTools,
  me,
  onGroupCreated,
  onOpenTool,
}: ConversationInfoFlowProps) => {
  const location = useLocation()
  const navigate = useNavigate()
  const phoneLayout = usePhoneLayout()
  const route = getConversationRoute(location.pathname)

  if (!route || route.channelId !== activeChannel.id || route.step === 'conversation') return null

  // `canAddPeople` (DM vs. standard channel) can only narrow further: a plain
  // member without `canManageChannel` standing must not see a control that the
  // service refuses. See `docs/standards/disclosure-boundaries.md`.
  const canManageMembers = canAddPeople && activeChannel.viewerCanManage
  const members = channelUsers
  const memberCount = members.length
  const title = route.step === 'info'
    ? 'Conversation info'
    : route.step === 'members'
      ? `${memberCount} member${memberCount === 1 ? '' : 's'}`
      : 'Add people'
  const mobileClassName = phoneLayout
    // The bottom pad is the iPhone shell's tab-bar clearance where that shell
    // publishes one: this overlay is outside `.phone-navigation-page`, so the
    // spacer that lifts a page's last row above the native tab bar never
    // reaches it. Everywhere else it falls back to the safe-area inset.
    ? 'fixed inset-0 z-[80] flex min-h-0 flex-col bg-[color:var(--main)] pb-[var(--nessie-native-phone-tabbar-clearance,env(safe-area-inset-bottom,0px))] pt-[env(safe-area-inset-top,0px)]'
    : 'absolute inset-y-0 right-0 z-50 flex w-[min(420px,100%)] min-h-0 flex-col border-l border-[color:var(--sep)] bg-[color:var(--main)] shadow-2xl'
  const actions: PageHeaderAction[] | undefined = route.step === 'members' && canManageMembers
    ? [{
        id: 'add-people',
        label: 'Add',
        onSelect: () => void navigate(`/channels/${activeChannel.id}/info/members/add`),
        priority: 100,
      }]
    : undefined

  return (
    <section aria-label={title} className={mobileClassName}>
      <ScreenHeader actions={actions} title={title} />

      {route.step === 'info' ? (
        <ConversationOverview
          activeChannel={activeChannel}
          canAddPeople={canManageMembers}
          channelUsers={members}
          hasAgentTools={hasAgentTools}
          memberCount={memberCount}
          onOpenAddPeople={() => void navigate(`/channels/${activeChannel.id}/info/members/add`)}
          onOpenFiles={() => void navigate(`/channels/${activeChannel.id}?tab=files`)}
          onOpenMembers={() => void navigate(`/channels/${activeChannel.id}/info/members`)}
          onOpenMessages={() => void navigate(`/channels/${activeChannel.id}`)}
          onOpenTool={(tool) => {
            // The tool opens over the conversation, not over this screen: step
            // back to the room first so Back from the tool lands where the
            // reader expects.
            void navigate(`/channels/${activeChannel.id}`)
            onOpenTool(tool)
          }}
          threadId={activeThreadId}
        />
      ) : null}

      {route.step === 'members' ? (
        <ConversationMembers
          activeChannel={activeChannel}
          channelUsers={members}
          currentUserId={me.user.id}
        />
      ) : null}

      {route.step === 'add-members' && canManageMembers ? (
        <AddConversationMembers
          activeChannel={activeChannel}
          allUsers={allUsers}
          channelUsers={members}
          currentUserId={me.user.id}
          onGroupCreated={onGroupCreated}
        />
      ) : null}

      {route.step === 'add-members' && !canManageMembers ? (
        <p className="px-6 py-8 text-center text-sm text-[color:var(--tx3)]">
          {activeChannel.type === 'dm'
            ? 'Direct messages are between two participants. Start a channel to include more people.'
            : 'Ask a team owner to add people to this conversation.'}
        </p>
      ) : null}
    </section>
  )
}
