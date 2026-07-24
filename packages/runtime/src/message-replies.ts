import type { PrismaClient } from '@prisma/client'

// Message-level reply threads (#233): shared bookkeeping for the materialized
// per-root reply metadata and per-user follows. Used by both the API message
// service (user replies) and the worker run-execution paths (agent replies)
// so root counters can never drift between authors.

// Upper bound on the denormalized participant list — the collapsed bar renders
// at most 5 avatars, so 50 is generous headroom while bounding row growth.
export const REPLY_PARTICIPANT_LIMIT = 50

export type ReplyBookkeepingClient = Pick<PrismaClient, '$queryRaw'>

export type ReplyRootMetadata = {
  replyCount: number
  lastReplyAt: Date | null
  replyParticipantIds: string[]
}

type ReplyRootMetadataRow = {
  reply_count: number
  last_reply_at: Date | null
  reply_participant_ids: string[]
}

// Atomically increments the root's reply counter, advances lastReplyAt, and
// appends the reply author (user or agent id) to the participant list with
// dedupe + cap — all in a single UPDATE so concurrent replies cannot lose
// counts. Returns the post-update metadata for realtime fan-out.
export const applyReplyBookkeeping = async (
  client: ReplyBookkeepingClient,
  args: { rootMessageId: string; replyCreatedAt: Date; authorId: string | null },
): Promise<ReplyRootMetadata> => {
  const rows = await client.$queryRaw<ReplyRootMetadataRow[]>`
    UPDATE "messages"
    SET "reply_count" = "reply_count" + 1,
        "last_reply_at" = GREATEST(
          COALESCE("last_reply_at", '-infinity'::timestamp),
          ${args.replyCreatedAt}::timestamp
        ),
        "reply_participant_ids" = CASE
          WHEN ${args.authorId}::uuid IS NULL
            OR "reply_participant_ids" @> ARRAY[${args.authorId}]::uuid[]
            OR COALESCE(array_length("reply_participant_ids", 1), 0) >= ${REPLY_PARTICIPANT_LIMIT}
          THEN "reply_participant_ids"
          ELSE array_append("reply_participant_ids", ${args.authorId}::uuid)
        END
    WHERE "id" = ${args.rootMessageId}::uuid
    RETURNING "reply_count", "last_reply_at", "reply_participant_ids"
  `
  const row = rows[0]
  if (!row) {
    throw new Error(`reply bookkeeping: root message ${args.rootMessageId} not found`)
  }
  return {
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    replyParticipantIds: row.reply_participant_ids,
  }
}

export type ReplyFollowClient = Pick<PrismaClient, 'messageThreadFollow'>

// Auto-follow on participate: root authors, reply authors, and users mentioned
// in a reply follow the reply thread. Idempotent via the (root, user) unique
// pair; only called for real user ids (agents never follow).
export const followReplyThread = async (
  client: ReplyFollowClient,
  args: { rootMessageId: string; userIds: string[] },
): Promise<void> => {
  const uniqueUserIds = [...new Set(args.userIds)]
  if (uniqueUserIds.length === 0) return
  await client.messageThreadFollow.createMany({
    data: uniqueUserIds.map((userId) => ({ rootMessageId: args.rootMessageId, userId })),
    skipDuplicates: true,
  })
}

export const unfollowReplyThread = async (
  client: ReplyFollowClient,
  args: { rootMessageId: string; userId: string },
): Promise<void> => {
  await client.messageThreadFollow.deleteMany({
    where: { rootMessageId: args.rootMessageId, userId: args.userId },
  })
}
