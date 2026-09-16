import type { PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseUserId,
  type ChannelDirectoryEntry,
  type ProjectDirectoryMember,
} from '@nessie/schemas'
import {
  channelTeamInclude,
  isGroupDm,
  mapChannelRecord,
} from '@nessie/team-admin'

/**
 * Reading ONE channel, including one the caller is not in.
 *
 * `GET /api/channels` lists rooms a person participates in or may browse. This
 * answers the different question a direct URL asks: *what may this person see
 * of this room?* — which is how a protected room is reached at all, since it is
 * deliberately absent from the browse list.
 *
 * Three answers, and the first is the one that matters most:
 *
 * - **Nothing.** `null`, which the route turns into `404 channel_not_found`,
 *   never a 403. A 403 confirms the room exists, and for a direct message that
 *   discloses who is talking to whom — a DM's label is built from its
 *   participants. The repo's rule is stated at
 *   `api/src/services/channel-members.ts` (`actorCanSee`) and every refusal
 *   here matches it.
 * - **`limited`.** An organisation member who is not in a standard room: its
 *   name, description, visibility and member list, so they know it exists and
 *   whom to ask. Nothing derived from its contents.
 * - **`full`.** A member, or an organisation owner/admin managing a room they
 *   never joined. The record carries `viewerIsMember`, which is what suppresses
 *   the composer for the admin — management is not participation.
 *
 * Every arm below is gated on a STANDARD, non-system, non-group-DM channel
 * before any of this applies. A direct message and a system surface answer
 * `null` to everybody outside them, whatever their organisation role, so
 * neither can surface in a directory, a search result or a lock affordance.
 */

type ChannelDirectoryViewer = {
  isOrganizationAdmin: boolean
  organizationId: string
  userId: string
}

/**
 * Is this a room the visibility model governs at all?
 *
 * The three conditions are one idea — "a channel people were invited into,
 * rather than a conversation or a surface the system owns" — and they are
 * checked together everywhere so no new read can widen one of them by
 * accident. `type` alone is not enough: an `agent_email` surface is stored as
 * `type: 'standard'` and is still nobody's to browse.
 */
export const isDirectoryVisibleChannel = (
  channel: Parameters<typeof isGroupDm>[0],
): boolean =>
  channel.type === 'standard'
  && channel.systemChannelType === null
  && !isGroupDm(channel)

const toDirectoryMembers = (
  members: {
    userId: string
    user: {
      avatarAttachmentId: string | null
      avatarUrl: string | null
      displayName: string
    }
  }[],
  active: Set<string>,
): ProjectDirectoryMember[] =>
  members
    .filter((member) => active.has(member.userId))
    .map((member) => ({
      avatarAttachmentId: member.user.avatarAttachmentId,
      avatarUrl: member.user.avatarUrl,
      displayName: member.user.displayName,
      userId: parseUserId(member.userId),
    }))

const rosterInclude = {
  select: {
    userId: true,
    user: { select: { avatarAttachmentId: true, avatarUrl: true, displayName: true } },
  },
  orderBy: { createdAt: 'asc' },
} as const

/**
 * Deactivated people are dropped from every roster: a membership row outlives
 * the person's access, and a name on a list is a disclosure of its own.
 */
const materialiseRoster = async (
  prisma: PrismaClient,
  organizationId: string,
  members: Parameters<typeof toDirectoryMembers>[0],
): Promise<ProjectDirectoryMember[]> => {
  const active = await prisma.organizationMember.findMany({
    where: { organizationId, deactivatedAt: null },
    select: { userId: true },
  })
  return toDirectoryMembers(members, new Set(active.map((member) => member.userId)))
}

/**
 * The roster behind `GET /api/channels/:channelId/members`.
 *
 * It exists because the members popup used to derive who was in a channel from
 * `GET /api/users`, which meant an admin needed the owner-shaped user list to
 * draw it — and that list discloses other people's direct messages
 * (`api/src/services/users.ts`). Asking the channel for its own members answers
 * the question without widening the person directory for anybody.
 *
 * Returns `null` for a caller who may not see the channel, so the route can
 * answer `channel_not_found` rather than distinguishing "no roster for you"
 * from "no such room".
 */
export const readChannelRoster = async (
  prisma: PrismaClient,
  viewer: ChannelDirectoryViewer,
  channelId: string,
): Promise<ProjectDirectoryMember[] | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      deletedAt: true,
      dmKey: true,
      organizationId: true,
      systemChannelType: true,
      type: true,
      visibility: true,
      members: rosterInclude,
    },
  })
  if (!channel || channel.deletedAt || channel.organizationId !== viewer.organizationId) {
    return null
  }
  const viewerIsMember = channel.members.some((member) => member.userId === viewer.userId)

  // A member of a direct message reads its roster. Nobody else reaches one —
  // an organisation admin included, because a DM's participants ARE the
  // disclosure, not merely metadata about it.
  if (!isDirectoryVisibleChannel(channel)) {
    return viewerIsMember ? await materialiseRoster(prisma, viewer.organizationId, channel.members) : null
  }

  // Everyone else who may see the room may see who is in it: a member, an
  // organisation admin managing it, and an organisation member looking at a
  // public room or the limited overview of a protected one. "Whom do I ask to
  // be let in?" is the whole point of the protected shape.
  return await materialiseRoster(prisma, viewer.organizationId, channel.members)
}

/**
 * `GET /api/channels/:channelId`. `null` means `channel_not_found`.
 */
export const readChannelForViewer = async (
  prisma: PrismaClient,
  viewer: ChannelDirectoryViewer,
  channelId: string,
): Promise<ChannelDirectoryEntry | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { ...channelTeamInclude, members: rosterInclude },
  })
  if (!channel || channel.deletedAt || channel.organizationId !== viewer.organizationId) {
    return null
  }

  const viewerIsMember = channel.members.some((member) => member.userId === viewer.userId)
  const full = async (): Promise<ChannelDirectoryEntry> => ({
    access: 'full',
    channel: await mapChannelRecord(prisma, channel, viewer.userId, {
      isOrganizationAdmin: viewer.isOrganizationAdmin,
    }),
    viewerIsMember,
  })

  // A direct message or a system surface: participation is the only key, and a
  // non-participant is told the room does not exist rather than that it is
  // closed. An organisation admin gets no exception here — a DM is not an
  // organisational resource to manage.
  if (!isDirectoryVisibleChannel(channel)) {
    return viewerIsMember ? await full() : null
  }

  // A member reads their own room; an owner/admin reads any standard room as
  // management, with `viewerIsMember: false` telling the client to draw the
  // settings but not the composer.
  if (viewerIsMember || viewer.isOrganizationAdmin) return await full()

  // A public room is browsable without joining, so an organisation member gets
  // the whole record and a Join action rather than the limited shape.
  if (channel.visibility === 'public') return await full()

  // `private` is reserved for DMs and system surfaces, which the check above
  // already sent away. Reaching here means a standard row still carries it —
  // one the backfill missed, or one a future writer set — and the answer is
  // that the room does not exist, not a limited shape. Fail closed: the
  // limited arm below is only ever reached for `protected`.
  if (channel.visibility !== 'protected') return null

  // Protected, and they are not in it: name, members, and nothing derived from
  // what has been said in it. `visibility` is written as the literal the arm
  // has already established rather than passed through from the row, so a
  // stored `private` standard channel — which the backfill should have moved,
  // but which no read should trust — cannot reach the wire through this shape.
  return {
    access: 'limited',
    description: channel.description ?? null,
    id: parseChannelId(channel.id),
    label: channel.label,
    members: await materialiseRoster(prisma, viewer.organizationId, channel.members),
    projectName: channel.project.name,
    teamName: channel.team.name,
    visibility: 'protected',
  }
}
