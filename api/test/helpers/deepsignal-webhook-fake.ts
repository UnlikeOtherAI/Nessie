import type { PrismaClient } from '@prisma/client'

export const USER_A = '00000000-0000-4000-8000-0000000000b1'
export const USER_B = '00000000-0000-4000-8000-0000000000b2'
export const LOCAL_TEAM_A = '00000000-0000-4000-8000-0000000000c1'
export const LOCAL_TEAM_B = '00000000-0000-4000-8000-0000000000c2'
export const ORG = '00000000-0000-4000-8000-0000000000a1'
export const UOA_ORG = 'uoa-org'
export const UOA_TEAM_A = 'team-ds'
export const UOA_TEAM_B = 'team-ds-b'

export type Link = {
  activeOrgId?: string | null
  activeTeamId?: string | null
  channelTeamIds?: string[]
  memberTeamIds?: string[]
  organizationActive?: boolean
  organizationId: string
  userId: string
  productSlug: string
  status: string
  uoaSub: string | null
}

export type TeamEnablement = {
  enabled: boolean
  externalOrgId: string | null
  externalTeamId: string | null
  organizationId: string
  productSlug: string
  teamExternalOrgId?: string | null
  teamExternalWorkspaceId?: string | null
  teamId: string
}

export type StoredMessage = {
  id: string
  threadId: string
  role: string
  agentId: string | null
  content: string
  createdAt: Date
  deletedAt: Date | null
  metadata: Record<string, unknown>
}

export const messageInsightIds = (message: StoredMessage): string[] =>
  ((message.metadata.external as { insights?: Array<{ insightId: string }> })?.insights ?? []).map(
    (entry) => entry.insightId,
  )

export const digestInsights = (
  message: StoredMessage,
): Array<{ insightId: string; kind: string | null }> =>
  ((message.metadata.external as { insights?: Array<{ insightId: string; kind: string | null }> })
    ?.insights ?? [])

export const makeInsightFake = (
  links: Link[],
  enablements: TeamEnablement[] = [
    {
      enabled: true,
      externalOrgId: UOA_ORG,
      externalTeamId: UOA_TEAM_A,
      organizationId: ORG,
      productSlug: 'deepsignal',
      teamId: LOCAL_TEAM_A,
    },
  ],
) => {
  const messages: StoredMessage[] = []
  const state = { clock: new Date('2026-07-12T00:00:00.000Z') }
  const channels = new Map<string, { id: string; archivedAt: Date | null }>()
  for (const link of links) {
    for (const channelTeamId of link.channelTeamIds ?? [link.activeTeamId ?? UOA_TEAM_A]) {
      channels.set(
        `extagent:deepsignal:${link.organizationId}:${link.userId}:${channelTeamId}`,
        {
          id: `chan-${link.userId}-${channelTeamId}`,
          archivedAt: null,
        },
      )
    }
  }
  const client = {
    messages,
    state,
    productTeamEnablement: {
      findFirst: async (args: {
        where: {
          enabled: boolean
          externalTeamId: string
          organizationId: string
          productSlug: string
        }
      }) => {
        const row = enablements.find(
          (enablement) =>
            enablement.enabled === args.where.enabled
            && enablement.externalTeamId === args.where.externalTeamId
            && enablement.organizationId === args.where.organizationId
            && enablement.productSlug === args.where.productSlug,
        )
        if (!row) return null
        return {
          externalOrgId: row.externalOrgId,
          externalTeamId: row.externalTeamId,
          teamId: row.teamId,
          team: {
            externalOrgId: row.teamExternalOrgId ?? row.externalOrgId,
            externalWorkspaceId:
              row.teamExternalWorkspaceId ?? row.externalTeamId,
          },
        }
      },
    },
    productAccountLink: {
      findMany: async (args: {
        where: {
          organizationId: string
          productSlug: string
          status: string
          uoaSub?: { in: string[] }
          user: {
            organizationMembers: {
              some: { deactivatedAt: null; organizationId: string }
            }
            teamMembers: { some: { teamId: string } }
          }
        }
      }) =>
        links
          .filter(
            (link) =>
              link.organizationId === args.where.organizationId
              && link.productSlug === args.where.productSlug
              && link.status === args.where.status
              && (link.organizationActive ?? true)
              && (link.memberTeamIds ?? [LOCAL_TEAM_A]).includes(
                args.where.user.teamMembers.some.teamId,
              )
              && (
                !args.where.uoaSub
                || args.where.uoaSub.in.includes(link.uoaSub ?? '')
              ),
          )
          .map((link) => ({ userId: link.userId })),
    },
    channel: {
      findUnique: async (args: { where: { dmKey: string } }) =>
        channels.get(args.where.dmKey) ?? null,
    },
    thread: {
      findFirst: async (args: { where: { channelId: string } }) => ({
        id: `thread-${args.where.channelId}`,
      }),
      create: async (args: { data: { channelId: string } }) => ({
        id: `thread-${args.data.channelId}`,
      }),
    },
    agentBinding: {
      findFirst: async () => ({ agentId: 'agent-ds' }),
    },
    $executeRaw: async () => 0,
    message: {
      findFirst: async (args: {
        where: {
          threadId: string
          deletedAt: null
          metadata: { array_contains: Array<{ insightId: string }> }
        }
      }) => {
        const target = args.where.metadata.array_contains[0]!.insightId
        const match = messages.find(
          (message) =>
            message.threadId === args.where.threadId
            && message.deletedAt === null
            && messageInsightIds(message).includes(target),
        )
        return match ? { id: match.id } : null
      },
      findMany: async (args: {
        where: {
          threadId: string
          deletedAt: null
          createdAt: { gte: Date }
          metadata: { equals: string }
        }
        orderBy: { createdAt: 'desc' }
      }) =>
        messages
          .filter(
            (message) =>
              message.threadId === args.where.threadId
              && message.deletedAt === null
              && message.createdAt.getTime() >= args.where.createdAt.gte.getTime()
              && (
                message.metadata.external as { kind?: string }
              )?.kind === args.where.metadata.equals,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async (
        args: { data: Omit<StoredMessage, 'id' | 'createdAt' | 'deletedAt'> },
      ) => {
        const row: StoredMessage = {
          ...args.data,
          id: `msg-${messages.length + 1}`,
          createdAt: state.clock,
          deletedAt: null,
        }
        messages.push(row)
        return { id: row.id }
      },
      update: async (
        args: { where: { id: string }; data: Partial<StoredMessage> },
      ) => {
        const row = messages.find((message) => message.id === args.where.id)!
        Object.assign(row, args.data)
        return { id: row.id }
      },
    },
  }
  return Object.assign(client, {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  })
}

export type InsightFake = ReturnType<typeof makeInsightFake>

export const asPrisma = (fake: InsightFake): PrismaClient =>
  fake as unknown as PrismaClient

export const insightPayload = (
  insightId: string,
  extra: Record<string, unknown> = {},
) => ({
  event: 'insight.surfaced',
  teamId: UOA_TEAM_A,
  insightId,
  actions: ['done', 'snooze', 'mute', 'reopen'],
  brief: {
    insightId,
    whatChanged: 'Supplier risk detected',
    whyItMatters: 'A key supplier may miss delivery',
    recommendedAction: 'Contact procurement',
    kind: 'risk',
    band: 'high',
  },
  ...extra,
})
