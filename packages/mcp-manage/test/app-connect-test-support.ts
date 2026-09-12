import type {
  McpClientManager,
  McpConnectionId,
  McpToolDescriptor,
} from '@nessie/mcp-client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import {
  createInMemoryStateStore,
  type McpCatalogEntryRow,
  type McpInstanceRow,
} from '../src/index.js'
import type { AppConnectContext } from '../src/apps/app-connect.js'
import type { OAuthDiscoveryOptions } from '../src/oauth-discovery.js'

export const ORG = '00000000-0000-4000-8000-00000000000a'
export const MEMBER = '00000000-0000-4000-8000-0000000000c1'
export const OTHER = '00000000-0000-4000-8000-0000000000c2'
export const PROJECT = '00000000-0000-4000-8000-0000000000d1'
const ENDPOINT = 'https://93.184.216.34/mcp'

export const actor = (userId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    tenant: { organizationId: ORG },
    actor: { actorId: userId, actorType: 'user', roles },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

export const catalogEntry = (
  overrides: Partial<McpCatalogEntryRow> = {},
): McpCatalogEntryRow =>
  ({
    id: 'entry-1',
    organizationId: ORG,
    name: 'acme',
    label: 'Acme',
    description: '',
    protocol: 'http',
    authMethod: 'none',
    authConfig: { method: 'none' },
    defaultTransportConfig: { transport: 'http', url: ENDPOINT },
    status: 'published',
    visibility: 'private',
    locked: false,
    ownerUserId: MEMBER,
    ...overrides,
  }) as unknown as McpCatalogEntryRow

export const instanceRow = (overrides: Partial<McpInstanceRow> = {}): McpInstanceRow => ({
  id: 'instance-1',
  catalogEntryId: 'entry-1',
  organizationId: ORG,
  scopeType: 'user',
  scopeId: MEMBER,
  credentialRef: null,
  transportConfig: {},
  discoveredTools: [],
  lifecycleState: 'pending_setup',
  healthLastCheckedAt: null,
  healthFailureCount: 0,
  lastError: null,
  installedBy: MEMBER,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const managerFactory = (
  behaviour: { descriptors?: McpToolDescriptor[]; failWith?: string },
) => () =>
  ({
    open: async () => 'connection-1' as McpConnectionId,
    listTools: async () => {
      if (behaviour.failWith) throw new Error(behaviour.failWith)
      return behaviour.descriptors ?? []
    },
    close: async () => undefined,
    closeAll: async () => undefined,
  }) as unknown as McpClientManager

type StubOptions = {
  entry?: McpCatalogEntryRow
  instance?: McpInstanceRow | null
  instanceAtScope?: McpInstanceRow | null
  credentialRef?: string | null
  role?: 'owner' | 'admin' | 'member'
  probe?: { descriptors?: McpToolDescriptor[]; failWith?: string }
  actorId?: string
  appSource?: string
  discoverAuthMethod?: 'none' | 'bearer' | 'api_key' | 'oauth2'
  oauthDiscovery?: OAuthDiscoveryOptions
}

export type AppConnectStub = {
  catalogWrites: Record<string, unknown>[]
  ctx: AppConnectContext
  created: Record<string, unknown>[]
  deleted: string[]
  discoveryUrls: string[]
  updates: Record<string, unknown>[]
  connection: () => McpInstanceRow | null
}

export const makeAppConnectStub = (options: StubOptions = {}): AppConnectStub => {
  let entry = options.entry ?? catalogEntry()
  let current: McpInstanceRow | null =
    options.instance === undefined ? instanceRow() : options.instance
  const catalogWrites: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const deleted: string[] = []
  const discoveryUrls: string[] = []
  const updates: Record<string, unknown>[] = []

  const toolRegistry = {
    findMany: async () => [],
    upsert: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  }
  const applyUpdate = (data: Record<string, unknown>): McpInstanceRow => {
    updates.push(data)
    const plain = { ...data }
    delete plain.healthFailureCount
    current = { ...(current ?? instanceRow()), ...plain } as McpInstanceRow
    return current
  }
  const discoverEndpoint = async (url: string) => {
    discoveryUrls.push(url)
    return {
      input: url,
      ok: true,
      attempts: [],
      proposal: options.discoverAuthMethod
        ? { url, transport: 'http' as const, authMethod: options.discoverAuthMethod, toolNames: [], note: null }
        : null,
    }
  }
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async (args: { where?: { name?: unknown } }) =>
        args.where?.name === undefined ? entry : null,
      findUnique: async () => ({ appSource: options.appSource ?? 'nessie' }),
      update: async (args: { data: Record<string, unknown> }) => {
        catalogWrites.push(args.data)
        entry = { ...entry, ...args.data } as McpCatalogEntryRow
        return entry
      },
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
    },
    mcpServerInstance: {
      findFirst: async (args: { where?: { id?: string } }) =>
        args.where?.id === undefined ? options.instanceAtScope ?? null : current,
      findUnique: async () => current,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return { ...instanceRow(), ...args.data, id: 'instance-new' }
      },
      update: async (args: { data: Record<string, unknown> }) => applyUpdate(args.data),
      delete: async (args: { where: { id: string } }) => {
        deleted.push(args.where.id)
        return current
      },
    },
    mcpServerCredentialOverride: {
      findUnique: async () =>
        options.credentialRef ? { credentialRef: options.credentialRef } : null,
    },
    organizationMember: {
      findUnique: async () => ({ role: options.role ?? 'member', deactivatedAt: null }),
    },
    teamMember: { findMany: async () => [] },
    channelMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    mcpOAuthState: { create: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    mcpOAuthClient: {
      findUnique: async () => null,
      upsert: async (args: { create: { clientId: string; clientSecretRef: string | null } }) =>
        ({ clientId: args.create.clientId, clientSecretRef: args.create.clientSecretRef }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        agent: { findFirst: async () => null },
        mcpServerInstance: {
          update: async (args: { data: Record<string, unknown> }) => applyUpdate(args.data),
        },
        toolRegistryEntry: toolRegistry,
      }),
  } as unknown as PrismaClient

  return {
    created,
    deleted,
    discoveryUrls,
    updates,
    catalogWrites,
    connection: () => current,
    ctx: {
      prisma,
      actorContext: actor(options.actorId ?? MEMBER, options.role === 'owner' ? ['owner'] : []),
      oauth: {
        callbackUrl: 'https://93.184.216.34/api/mcp/oauth/callback',
        stateStore: createInMemoryStateStore(),
        discovery: options.oauthDiscovery,
      },
      managerFactory: managerFactory(options.probe ?? {}),
      discoverEndpoint: discoverEndpoint as never,
    },
  }
}
