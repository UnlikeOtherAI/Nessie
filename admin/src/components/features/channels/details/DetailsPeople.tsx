import { useMemo, useState } from 'react'
import { useAddChannelMember, useRemoveChannelMember } from '../../../../facades/channels/hooks'
import type { ChannelRecord, UserRecord } from '../../../../lib/api-client'
import { AvailableUserRow, CurrentUserRow } from '../../../shared/channel-members/MemberUserRow'
import { useUserMemberFilters } from '../../../shared/channel-members/useMemberFilters'
import { FormError } from '../../../shared/FormActions'
import { Input } from '../../../shared/FormControls'
import { isRoom } from './details-sections'

/**
 * Whether people can be added here at all, and by this reader: a direct
 * message is a fixed group the member routes refuse to change, and in a room
 * `viewerCanManage` (any member, or an organisation owner or admin) is the
 * server's own answer (`canModifyChannel`).
 */
export const canAddPeople = (channel: ChannelRecord): boolean =>
  isRoom(channel) && channel.viewerCanManage

type DetailsPeopleProps = {
  channel: ChannelRecord
  channelUsers: UserRecord[]
  currentUserId: string
}

/**
 * Details › People: who is in this conversation, and removing them. Adding is
 * the screen over this one (`/info/members/add`), opened from the header's
 * Add. Agents are not people and are placed under Agents, by a narrower
 * authority than adding a person — the one line below says who, so nobody
 * looks for them here.
 */
export const DetailsPeople = ({ channel, channelUsers, currentUserId }: DetailsPeopleProps) => {
  const removeMember = useRemoveChannelMember()
  const [search, setSearch] = useState('')
  const { filteredUsers } = useUserMemberFilters({ allUsers: [], members: channelUsers, search })
  const room = isRoom(channel)

  return (
    <div className="grid gap-3">
      <p className="text-sm text-[color:var(--tx2)]">
        {room
          ? 'Agents are placed under Agents, by an organisation owner or admin.'
          : 'A direct message stays between the people in it. Start a channel to include more people.'}
      </p>
      <Input
        aria-label="Search people"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search people"
        value={search}
      />
      <FormError>
        {removeMember.error instanceof Error ? removeMember.error.message : undefined}
      </FormError>
      <div className="grid gap-0.5">
        {filteredUsers.map((person) => (
          <CurrentUserRow
            // A direct message's participants are fixed: nobody removes one.
            canRemove={room && channel.viewerCanManage}
            currentUserId={currentUserId}
            key={person.id}
            onRemove={(userId) => removeMember.mutate({ channelId: channel.id, userId })}
            removeLabel="Remove from channel"
            removePending={removeMember.isPending}
            user={person}
          />
        ))}
        {filteredUsers.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">Nobody here matches that search.</p>
        ) : null}
      </div>
    </div>
  )
}

type DetailsAddPeopleProps = {
  allUsers: UserRecord[]
  channel: ChannelRecord
  channelUsers: UserRecord[]
  currentUserId: string
}

/** The screen over People that adds a person to a room. */
export const DetailsAddPeople = ({ allUsers, channel, channelUsers, currentUserId }: DetailsAddPeopleProps) => {
  const addMember = useAddChannelMember()
  const [search, setSearch] = useState('')
  const others = useMemo(
    () => allUsers.filter((person) => person.id !== currentUserId),
    [allUsers, currentUserId],
  )
  const { availableUsers } = useUserMemberFilters({ allUsers: others, members: channelUsers, search })

  if (!canAddPeople(channel)) {
    return (
      <p className="py-8 text-center text-sm text-[color:var(--tx3)]">
        {isRoom(channel)
          ? 'Only members of this channel, or an organisation owner or admin, can add people to it.'
          : 'A direct message stays between the people in it. Start a channel to include more people.'}
      </p>
    )
  }

  return (
    <div className="grid gap-3">
      <Input
        aria-label="Find people to add"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Type a name or email address"
        value={search}
      />
      <p className="text-xs text-[color:var(--tx3)]">People already in this conversation are not shown.</p>
      <FormError>{addMember.error instanceof Error ? addMember.error.message : undefined}</FormError>
      <div className="grid gap-0.5">
        {availableUsers.map((person) => (
          <AvailableUserRow
            addPending={addMember.isPending}
            key={person.id}
            onAdd={(userId) => addMember.mutate({ channelId: channel.id, userId })}
            user={person}
          />
        ))}
        {availableUsers.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">No people are available to add.</p>
        ) : null}
      </div>
    </div>
  )
}
