import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type {
  AccountLink,
  Agent,
  AgentBinding,
  Channel,
  ChannelMember,
  ChannelUpdateManyArgs,
  ExternalAgentFakeSeed,
  Instance,
  Team,
  Thread,
} from './external-agent-prisma-fake-model.js'
import { matchesChannelUpdateMany } from './external-agent-prisma-fake-model.js'

/**
 * Purpose-built in-memory Prisma fake covering exactly the operations the
 * external-agent bootstrap + activation/deactivation flows perform. Stateful,
 * so idempotency and side-effect assertions are meaningful. Shared by the
 * bootstrap and activation tests.
 */

export const makeExternalAgentPrismaFake = (
  seed: ExternalAgentFakeSeed,
) => {
  const projects = new Map<string, string>([[seed.projectId, seed.organizationId]])
  const teams = new Map<string, Team>([
    [
      seed.teamId,
      {
        id: seed.teamId,
        externalOrgId: seed.externalOrgId ?? 'uoa-org',
        externalWorkspaceId: seed.externalWorkspaceId ?? 'uoa-team',
        name: 'Seed Team',
        projectId: seed.projectId,
        systemManaged: false,
        organizationId: seed.organizationId,
      },
    ],
  ])
  const agents: Agent[] = []
  const channelsByKey = new Map<string, Channel>()
  const channelsById = new Map<string, Channel>()
  const channelMembers: ChannelMember[] = []
  const threads: Thread[] = []
  const agentBindings: AgentBinding[] = []
  const catalogEntries = seed.catalogEntries ?? []
  const instances = seed.instances ?? []
  const accountLinks: AccountLink[] = [...(seed.accountLinks ?? [])]
  const credentialOverrides: Array<{ instanceId: string }> = []
  const toolRegistryEntries: Array<{ id: string; mcpInstanceId: string }> = []
  const enablements = new Map<string, boolean>(
    (seed.teamEnablements ?? []).map((e) => [`${e.teamId}:${e.productSlug}`, e.enabled]),
  )

  const self = {
    teams,
    agents,
    channelsById,
    channelMembers,
    threads,
    agentBindings,
    instances,
    accountLinks,
    credentialOverrides,
    toolRegistryEntries,
    $executeRaw: async () => 0,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(self)
        : Promise.all(arg as Promise<unknown>[]),
    team: {
      findFirst: async (args: {
        where: {
          name?: string
          systemManaged?: boolean
          id?: string
          project: { organizationId: string }
        }
      }) => {
        const orgId = args.where.project.organizationId
        if (args.where.name !== undefined) {
          const found = [...teams.values()].find(
            (t) =>
              t.name === args.where.name
              && t.systemManaged === args.where.systemManaged
              && t.organizationId === orgId,
          )
          return found ? { id: found.id } : null
        }
        const seedTeam = teams.get(args.where.id ?? '')
        return seedTeam && seedTeam.organizationId === orgId
          ? {
              externalOrgId: seedTeam.externalOrgId,
              externalWorkspaceId: seedTeam.externalWorkspaceId,
              projectId: seedTeam.projectId,
            }
          : null
      },
      findUnique: async (args: { where: { id: string } }) => {
        const team = teams.get(args.where.id)
        if (!team) return null
        return { project: { id: team.projectId, organizationId: team.organizationId } }
      },
      create: async (args: {
        data: { name: string; projectId: string; systemManaged: boolean }
      }) => {
        const id = randomUUID()
        teams.set(id, {
          id,
          externalOrgId: null,
          externalWorkspaceId: null,
          name: args.data.name,
          projectId: args.data.projectId,
          systemManaged: args.data.systemManaged,
          organizationId: projects.get(args.data.projectId) ?? seed.organizationId,
        })
        return { id }
      },
    },
    agent: {
      findFirst: async (args: {
        where: {
          organizationId: string
          systemManaged: boolean
          executionMode: string
          name: string
        }
      }) => {
        const found = agents.find(
          (a) =>
            a.organizationId === args.where.organizationId
            && a.systemManaged === args.where.systemManaged
            && a.executionMode === args.where.executionMode
            && a.name === args.where.name,
        )
        return found ? { id: found.id } : null
      },
      update: async (args: { where: { id: string } }) => ({ id: args.where.id }),
      create: async (args: { data: Omit<Agent, 'id'> }) => {
        const id = randomUUID()
        agents.push({ id, ...args.data })
        return { id }
      },
    },
    channel: {
      upsert: async (args: {
        where: { dmKey: string }
        create: {
          label: string
          systemChannelType: string
          members?: { create: { userId: string; role: string } }
        }
      }) => {
        const existing = channelsByKey.get(args.where.dmKey)
        if (existing) return { id: existing.id }
        const id = randomUUID()
        const channel: Channel = {
          id,
          dmKey: args.where.dmKey,
          label: args.create.label,
          systemChannelType: args.create.systemChannelType,
          archivedAt: null,
        }
        channelsByKey.set(channel.dmKey, channel)
        channelsById.set(id, channel)
        if (args.create.members?.create) {
          channelMembers.push({
            channelId: id,
            userId: args.create.members.create.userId,
            role: args.create.members.create.role,
          })
        }
        return { id }
      },
      findUnique: async (args: { where: { dmKey: string } }) => {
        const channel = channelsByKey.get(args.where.dmKey)
        return channel ? { id: channel.id, archivedAt: channel.archivedAt } : null
      },
      findMany: async (args: {
        where: { dmKey: { startsWith: string } }
      }) =>
        [...channelsByKey.values()]
          .filter((channel) => channel.dmKey.startsWith(args.where.dmKey.startsWith))
          .map((channel) => ({ id: channel.id, archivedAt: channel.archivedAt })),
      update: async (args: { where: { id: string }; data: { archivedAt?: Date } }) => {
        const channel = channelsById.get(args.where.id)
        if (channel && args.data.archivedAt !== undefined) {
          channel.archivedAt = args.data.archivedAt
        }
        return { id: args.where.id }
      },
      updateMany: async (args: ChannelUpdateManyArgs) => {
        let count = 0
        for (const channel of channelsById.values()) {
          if (!matchesChannelUpdateMany(channel, args.where)) continue
          channel.archivedAt = args.data.archivedAt
          count += 1
        }
        return { count }
      },
    },
    channelMember: {
      upsert: async (args: {
        where: { channelId_userId: { channelId: string; userId: string } }
        create: { channelId: string; userId: string; role: string }
      }) => {
        const key = args.where.channelId_userId
        const existing = channelMembers.find(
          (m) => m.channelId === key.channelId && m.userId === key.userId,
        )
        if (!existing) channelMembers.push({ ...args.create })
        return {}
      },
      deleteMany: async (args: {
        where: { channelId: string; userId: { not: string } }
      }) => {
        for (let i = channelMembers.length - 1; i >= 0; i -= 1) {
          const m = channelMembers[i]!
          if (m.channelId === args.where.channelId && m.userId !== args.where.userId.not) {
            channelMembers.splice(i, 1)
          }
        }
        return { count: 0 }
      },
    },
    thread: {
      findFirst: async (args: { where: { channelId: string } }) => {
        const found = threads
          .filter((t) => t.channelId === args.where.channelId)
          .sort((a, b) => a.createdAt - b.createdAt)[0]
        return found ? { id: found.id } : null
      },
      create: async (args: { data: { channelId: string } }) => {
        const id = randomUUID()
        threads.push({ id, channelId: args.data.channelId, createdAt: threads.length })
        return { id }
      },
    },
    agentBinding: {
      upsert: async (args: {
        where: { agentId_channelId: { agentId: string; channelId: string } }
      }) => {
        const key = args.where.agentId_channelId
        const existing = agentBindings.find(
          (b) => b.agentId === key.agentId && b.channelId === key.channelId,
        )
        if (!existing) agentBindings.push({ ...key })
        return {}
      },
    },
    productTeamEnablement: {
      findUnique: async (args: {
        where: {
          organizationId_teamId_productSlug: {
            organizationId: string
            teamId: string
            productSlug: string
          }
        }
      }) => {
        const key = args.where.organizationId_teamId_productSlug
        const enabled = enablements.get(`${key.teamId}:${key.productSlug}`)
        return enabled === undefined ? null : { enabled }
      },
    },
    mcpCatalogEntry: {
      findFirst: async (args: {
        where: {
          id?: string
          name?: string
          organizationId?: string | null
          visibility?: string
          status?: string
          integratedProducts?: { some: { slug: string } }
        }
      }) => {
        const integratedSlug = args.where.integratedProducts?.some.slug
        const found = catalogEntries.find(
          (e) =>
            (args.where.id === undefined || e.id === args.where.id)
            && (args.where.name === undefined || e.name === args.where.name)
            && (
              args.where.organizationId === undefined
              || (e.organizationId ?? null) === args.where.organizationId
            )
            && (
              args.where.visibility === undefined
              || e.visibility === args.where.visibility
            )
            && (
              args.where.status === undefined
              || e.status === args.where.status
            )
            && (
              integratedSlug === undefined
              || e.integratedProductSlugs?.includes(integratedSlug) === true
            )
        )
        return found
          ? {
              ...found,
              defaultTransportConfig: found.defaultTransportConfig ?? {},
              integratedProducts: (found.integratedProductSlugs ?? [])
                .map((slug) => ({ slug })),
              label: 'DeepSignal',
              locked: false,
              ownerUserId: null,
            }
          : null
      },
      findMany: async () => [],
    },
    mcpServerInstance: {
      findFirst: async (args: {
        where: {
          organizationId: string
          scopeType: string
          scopeId: string
          catalogEntryId?: string
          catalogEntry?: {
            name: string
            visibility: string
            integratedProducts?: { some: { slug: string } }
          }
        }
      }) => {
        const catalogName = args.where.catalogEntry?.name
        const found = instances.find((i) => {
          if (i.organizationId !== args.where.organizationId) return false
          if (i.scopeType !== args.where.scopeType || i.scopeId !== args.where.scopeId) {
            return false
          }
          if (args.where.catalogEntryId) return i.catalogEntryId === args.where.catalogEntryId
          if (catalogName) {
            const entry = catalogEntries.find((e) => e.id === i.catalogEntryId)
            const integratedSlug =
              args.where.catalogEntry?.integratedProducts?.some.slug
            return entry?.name === catalogName
              && (
                integratedSlug === undefined
                || entry.integratedProductSlugs?.includes(integratedSlug) === true
              )
          }
          return true
        })
        return found ?? null
      },
      create: async (args: {
        data: {
          catalogEntryId: string
          credentialRef: string | null
          lifecycleState: string
          organizationId: string
          scopeId: string
          scopeType: string
          transportConfig: unknown
        }
      }) => {
        const instance: Instance = {
          id: randomUUID(),
          ...args.data,
        }
        instances.push(instance)
        return instance
      },
      update: async (args: {
        where: { id: string }
        data: {
          credentialRef?: string
          lifecycleState?: string
          transportConfig?: unknown
        }
      }) => {
        const instance = instances.find((row) => row.id === args.where.id)
        if (!instance) throw new Error(`Missing instance ${args.where.id}`)
        Object.assign(instance, args.data)
        return instance
      },
      delete: async (args: { where: { id: string } }) => {
        const idx = instances.findIndex((i) => i.id === args.where.id)
        if (idx >= 0) instances.splice(idx, 1)
        return { id: args.where.id }
      },
    },
    mcpServerCredentialOverride: {
      deleteMany: async (args: { where: { instanceId: string } }) => {
        let count = 0
        for (let index = credentialOverrides.length - 1; index >= 0; index -= 1) {
          if (credentialOverrides[index]?.instanceId === args.where.instanceId) {
            credentialOverrides.splice(index, 1)
            count += 1
          }
        }
        return { count }
      },
    },
    organizationMember: {
      findUnique: async (args: {
        where: {
          organizationId_userId: {
            organizationId: string
            userId: string
          }
        }
      }) => {
        const key = args.where.organizationId_userId
        return key.organizationId === seed.organizationId
          ? { id: `${key.organizationId}:${key.userId}` }
          : null
      },
    },
    toolRegistryEntry: {
      deleteMany: async (args: { where: { mcpInstanceId: string } }) => {
        for (let i = toolRegistryEntries.length - 1; i >= 0; i -= 1) {
          if (toolRegistryEntries[i]!.mcpInstanceId === args.where.mcpInstanceId) {
            toolRegistryEntries.splice(i, 1)
          }
        }
        return { count: 0 }
      },
    },
    productAccountLink: {
      findUnique: async (args: {
        where: {
          organizationId_userId_productSlug: {
            organizationId: string
            userId: string
            productSlug: string
          }
        }
      }) => {
        const key = args.where.organizationId_userId_productSlug
        return accountLinks.find(
          (link) =>
            link.organizationId === key.organizationId
            && link.userId === key.userId
            && link.productSlug === key.productSlug,
        ) ?? null
      },
      upsert: async (args: {
        where: {
          organizationId_userId_productSlug: {
            organizationId: string
            userId: string
            productSlug: string
          }
        }
        create: AccountLink
        update: { status: string; uoaSub?: string | null }
      }) => {
        const key = args.where.organizationId_userId_productSlug
        const existing = accountLinks.find(
          (l) =>
            l.organizationId === key.organizationId
            && l.userId === key.userId
            && l.productSlug === key.productSlug,
        )
        if (existing) {
          existing.status = args.update.status
          if (args.update.uoaSub !== undefined) existing.uoaSub = args.update.uoaSub
        } else {
          accountLinks.push({
            activeOrgId: null,
            activeTeamId: null,
            ...args.create,
          })
        }
        return {}
      },
      updateMany: async (args: {
        where: { organizationId: string; userId: string; productSlug: string }
        data: { status: string }
      }) => {
        let count = 0
        for (const link of accountLinks) {
          if (
            link.organizationId === args.where.organizationId
            && link.userId === args.where.userId
            && link.productSlug === args.where.productSlug
          ) {
            link.status = args.data.status
            count += 1
          }
        }
        return { count }
      },
    },
  }

  return self
}

export const asPrisma = (fake: ReturnType<typeof makeExternalAgentPrismaFake>): PrismaClient =>
  fake as unknown as PrismaClient
