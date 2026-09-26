import type { PrismaClient } from '@prisma/client'

import { ensureSharedChannelRootInTransaction } from './channel-create.js'

/**
 * A system team: the hidden `systemManaged` Team a system surface's channels
 * hang from — every person's Personal Assistant DM, every global agent's home
 * DMs, an external-agent product's DMs. One per surface per organisation,
 * keyed by name under the surface's own advisory lock.
 *
 * It lives under the organisation's channel-root project: the one container
 * no person can delete (`deleteProject` refuses a `channelRoot` project), the
 * same home standalone channels and agent mailboxes use. Each surface used to
 * hang its team from the project of whichever user team happened to seed it
 * first — three copies of one function, each taking a "seed team" for that
 * alone — and deleting that project soft-deleted every member's Personal
 * Assistant and Agent Designer DM with it, while the bootstrap cleared only
 * `archivedAt` and so healed nothing.
 *
 * A team found under any other project is moved here, its channels with it,
 * so a row an older release created during a swap heals itself on the next
 * bootstrap; migration `20260926170000_system_teams_under_channel_root` moved
 * the existing rows in bulk.
 */
export const ensureSystemTeam = async (
  prisma: PrismaClient,
  input: {
    /** The surface's own advisory-lock key, so two surfaces never serialise on each other. */
    lockKey: string
    name: string
    organizationId: string
  },
): Promise<string> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.organizationId}),
        hashtext(${input.lockKey})
      )
    `
    const root = await ensureSharedChannelRootInTransaction(tx, input.organizationId)

    const existing = await tx.team.findFirst({
      where: {
        name: input.name,
        project: { organizationId: input.organizationId },
        systemManaged: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, projectId: true },
    })
    if (existing) {
      if (existing.projectId !== root.projectId) {
        await tx.team.update({
          where: { id: existing.id },
          data: { projectId: root.projectId },
        })
        await tx.channel.updateMany({
          where: { teamId: existing.id },
          data: { projectId: root.projectId },
        })
      }
      return existing.id
    }

    const team = await tx.team.create({
      data: {
        name: input.name,
        projectId: root.projectId,
        systemManaged: true,
      },
      select: { id: true },
    })
    return team.id
  })
