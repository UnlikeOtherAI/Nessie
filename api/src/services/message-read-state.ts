import { Prisma } from '@prisma/client'
import type { ChannelSystemType, PrismaClient, Thread } from '@prisma/client'
import {
  partitionByDisclosure,
  resolveDisclosureViewer,
  resolveGrantedScopeKeysForMessages,
  viewerSatisfiesBasis,
} from '@nessie/runtime'

/**
 * Which thread a person may open, and how far they have read in it.
 *
 * Both halves answer the same question from the reader's side — reachability
 * and position — and both are pure reads with no message row of their own,
 * which is why they sit apart from the feed's shape (`message-read-model.ts`)
 * and from editing (`message-edit.ts`).
 */

/**
 * How far back a read acknowledgement looks for the newest readable reply.
 * Only the newest one moves the cursor, so this is a bound on the search, not
 * on the conversation.
 */
const READ_CURSOR_CANDIDATE_LIMIT = 200

export const findThreadForUser = async (
  prisma: PrismaClient,
  threadId: string,
  userId: string,
  organizationId: string,
): Promise<
  (Thread & {
    channel: {
      id: string
      organizationId: string
      type: 'dm' | 'standard'
      systemChannelType: ChannelSystemType | null
    }
  }) | null
> =>
  prisma.thread.findFirst({
    where: {
      id: threadId,
      channel: {
        organizationId,
        OR: [
          { visibility: 'public' },
          { members: { some: { userId } } },
        ],
      },
    },
    include: {
      channel: {
        select: {
          id: true,
          organizationId: true,
          type: true,
          systemChannelType: true,
        },
      },
    },
  })

export const markThreadRead = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    rootMessageId?: string
    lastReadMessageId?: string
    threadId: string
    userId: string
  },
): Promise<boolean> => {
  // The original per-container cursor remains a safe baseline while existing
  // installs migrate. New acknowledgements always write the precise root
  // cursor instead, so opening reply A cannot make reply B look read.
  const legacyReadState = await prisma.threadReadState.findUnique({
    where: {
      threadId_userId: {
        threadId: input.threadId,
        userId: input.userId,
      },
    },
    select: { lastReadAt: true },
  })

  if (input.rootMessageId) {
    const root = await prisma.message.findFirst({
      where: {
        id: input.rootMessageId,
        rootMessageId: null,
        threadId: input.threadId,
        deletedAt: null,
      },
      select: {
        agentId: true,
        basisScopes: { select: { scopeId: true, scopeType: true } },
        createdAt: true,
        id: true,
      },
    })
    if (!root) return false

    // A stale or deep-linked panel can still name a root whose disclosure
    // basis the caller cannot read. Never let that placeholder advance a
    // durable cursor: it would turn a future grant into an already-read reply.
    const candidates = input.lastReadMessageId
      ? await prisma.message.findMany({
        where: {
          id: input.lastReadMessageId,
          threadId: input.threadId,
          deletedAt: null,
          role: { not: 'system' },
          OR: [{ id: input.rootMessageId }, { rootMessageId: input.rootMessageId }],
        },
        select: {
          agentId: true,
          basisScopes: { select: { scopeId: true, scopeType: true } },
          createdAt: true,
          id: true,
        },
      })
      : await prisma.message.findMany({
        where: {
          threadId: input.threadId,
          deletedAt: null,
          role: { not: 'system' },
          OR: [{ id: input.rootMessageId }, { rootMessageId: input.rootMessageId }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // Only the newest readable reply moves the cursor, so the whole
        // conversation never needs loading. Bounded rather than unbounded: a
        // reply panel with thousands of replies used to select every one of
        // them on every read acknowledgement. If the newest page is entirely
        // withheld the cursor stays at the root, which under-marks rather than
        // over-marks — the safe direction for a read receipt.
        take: READ_CURSOR_CANDIDATE_LIMIT,
        select: {
          agentId: true,
          basisScopes: { select: { scopeId: true, scopeType: true } },
          createdAt: true,
          id: true,
        },
      })
    if (input.lastReadMessageId && candidates.length === 0) return false

    const disclosureMayApply = root.basisScopes.length > 0
      || candidates.some((message) => message.basisScopes.length > 0)
    const viewer = disclosureMayApply
      ? await resolveDisclosureViewer(prisma, input.organizationId, input.userId)
      : null
    // Grants for every candidate the predicate would withhold, resolved once
    // for the whole set rather than per row inside the readability check.
    const withheld = viewer
      ? [...new Map([root, ...candidates].map((message) => [message.id, message])).values()]
        .filter((message) =>
          message.basisScopes.length > 0
          && partitionByDisclosure([message], viewer).withheld.length > 0)
      : []
    const channelId = withheld.length > 0
      ? (await prisma.thread.findUnique({
        where: { id: input.threadId },
        select: { channelId: true },
      }))?.channelId ?? null
      : null
    const grantsByMessage = channelId && viewer?.kind === 'user'
      ? await resolveGrantedScopeKeysForMessages(prisma, {
        channelId,
        messages: withheld.map((message) => ({
          agentId: message.agentId,
          basis: message.basisScopes,
          messageId: message.id,
        })),
        organizationId: input.organizationId,
        viewerChannelIds: viewer.scopes
          .filter((scope) => scope.scopeType === 'channel')
          .map((scope) => scope.scopeId),
        viewerUserId: input.userId,
      })
      : new Map<string, Set<string>>()
    const canRead = (message: {
      basisScopes: Array<{ scopeId: string; scopeType: string }>
      id: string
    }): boolean => {
      if (!viewer || message.basisScopes.length === 0) return true
      if (partitionByDisclosure([message], viewer).withheld.length === 0) return true
      return viewerSatisfiesBasis(
        message.basisScopes,
        viewer,
        grantsByMessage.get(message.id) ?? new Set<string>(),
      )
    }
    if (!canRead(root)) return false

    const latestMessage = input.lastReadMessageId
      ? candidates[0]
      : candidates.find((message) => canRead(message))
    if (input.lastReadMessageId && latestMessage && !canRead(latestMessage)) return false

    const cursorCandidates = [
      { at: root.createdAt, id: root.id },
      ...(latestMessage ? [{ at: latestMessage.createdAt, id: latestMessage.id }] : []),
      ...(legacyReadState ? [{ at: legacyReadState.lastReadAt, id: '' }] : []),
    ]
    const cursor = cursorCandidates.reduce((latest, candidate) =>
      candidate.at > latest.at || (candidate.at.getTime() === latest.at.getTime() && candidate.id > latest.id)
        ? candidate
        : latest,
    )

    // A read acknowledgement can arrive late from another tab or device. The
    // database, rather than timing in the browser, owns the monotonic cursor:
    // conflicting writes keep the lexicographically greatest (time, message)
    // pair, including Postgres timestamp(3) ties.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "message_conversation_read_states" (
        "id", "root_message_id", "user_id", "last_read_at", "last_read_message_id", "created_at", "updated_at"
      ) VALUES (
        gen_random_uuid(),
        ${input.rootMessageId}::uuid,
        ${input.userId}::uuid,
        ${cursor.at},
        ${cursor.id || null}::uuid,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("root_message_id", "user_id") DO UPDATE
      SET
        "last_read_at" = CASE
          WHEN EXCLUDED."last_read_at" > "message_conversation_read_states"."last_read_at"
            OR (
              EXCLUDED."last_read_at" = "message_conversation_read_states"."last_read_at"
              AND COALESCE(EXCLUDED."last_read_message_id"::text, '')
                > COALESCE("message_conversation_read_states"."last_read_message_id"::text, '')
            )
          THEN EXCLUDED."last_read_at"
          ELSE "message_conversation_read_states"."last_read_at"
        END,
        "last_read_message_id" = CASE
          WHEN EXCLUDED."last_read_at" > "message_conversation_read_states"."last_read_at"
            OR (
              EXCLUDED."last_read_at" = "message_conversation_read_states"."last_read_at"
              AND COALESCE(EXCLUDED."last_read_message_id"::text, '')
                > COALESCE("message_conversation_read_states"."last_read_message_id"::text, '')
            )
          THEN EXCLUDED."last_read_message_id"
          ELSE "message_conversation_read_states"."last_read_message_id"
        END,
        "updated_at" = CURRENT_TIMESTAMP
    `)
    return true
  }

  // The main feed shows roots but not their replies. Advance every visible
  // root only to its own creation time (or the old safe baseline), leaving
  // replies unread until their exact panel is opened.
  const baseline = legacyReadState?.lastReadAt ?? new Date(0)
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "message_conversation_read_states" (
      "id", "root_message_id", "user_id", "last_read_at", "created_at", "updated_at"
    )
    SELECT
      gen_random_uuid(),
      m.id,
      ${input.userId}::uuid,
      GREATEST(m.created_at, ${baseline}),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "messages" m
    WHERE m.thread_id = ${input.threadId}::uuid
      AND m.root_message_id IS NULL
    ON CONFLICT ("root_message_id", "user_id") DO UPDATE
      SET "last_read_at" = GREATEST(
        "message_conversation_read_states"."last_read_at",
        EXCLUDED."last_read_at"
      ),
      "updated_at" = CURRENT_TIMESTAMP
  `)
  return true
}
