import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  planToolDispatch,
  TOOL_DISPATCH_ERROR_CODES,
  ToolDispatchError,
} from '../src/services/tool-dispatch.js'
import type { SecretResolver } from '../src/services/secret-resolver.js'

/**
 * Regression coverage for the cross-org dispatch bypass closed in #19.
 *
 * `planToolDispatch` now resolves the registry entry with the same OR clause
 * used by createGrant/deleteGrant — global entries (`organizationId: null`)
 * remain dispatchable from every org, but org-owned entries can only be
 * dispatched by callers in the owning org.
 */

type ToolEntryFixture = {
  id: string
  organizationId: string | null
  enabled: boolean
  status: string
  transport: string
  transportConfig: unknown
  mcpInstanceId: string | null
}

const buildPrisma = (registry: ToolEntryFixture[]): PrismaClient => {
  const matchesWhere = (entry: ToolEntryFixture, where: any): boolean => {
    if (where.id && entry.id !== where.id) return false
    if (where.OR) {
      const matched = (where.OR as Array<{ organizationId: string | null }>).some(
        (clause) => entry.organizationId === clause.organizationId,
      )
      if (!matched) return false
    }
    return true
  }

  const prisma = {
    toolRegistryEntry: {
      findFirst: async ({ where }: { where: any }) =>
        registry.find((entry) => matchesWhere(entry, where)) ?? null,
    },
    toolGrant: {
      findMany: async () => [],
    },
  }

  return prisma as unknown as PrismaClient
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

test('planToolDispatch rejects when the tool belongs to a different org', async () => {
  const prisma = buildPrisma([
    {
      id: 'tool-orgB',
      organizationId: ORG_B,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-orgB', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.TOOL_NOT_FOUND,
  )
})

test('planToolDispatch passes registry lookup for global tools regardless of caller org', async () => {
  // Use an HTTP tool with no instance / no grant: this lets us assert that the
  // registry-lookup pass is what changed — we expect the call to advance past
  // the cross-org check and fail later on the grant check.
  const prisma = buildPrisma([
    {
      id: 'tool-global',
      organizationId: null,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-global', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.GRANT_DENIED,
  )
})

/**
 * Regression coverage for task #17: the dispatcher must default to a
 * `NullSecretResolver` so opaque `secret_*` credentialRefs never silently
 * resolve to `null` via the old `EnvSecretResolver` env-var lookup. The
 * dispatch must reach the transport with `secret: null`, not blow up earlier.
 */
type McpInstanceFixture = {
  id: string
  credentialRef: string | null
  lifecycleState: string
  transportConfig: unknown
  catalogEntry: { defaultTransportConfig: unknown }
}

const buildMcpPrisma = (options: {
  registry: ToolEntryFixture[]
  instances: McpInstanceFixture[]
  grantAllowed?: boolean
}): PrismaClient => {
  const matchesWhere = (entry: ToolEntryFixture, where: any): boolean => {
    if (where.id && entry.id !== where.id) return false
    if (where.OR) {
      const matched = (where.OR as Array<{ organizationId: string | null }>).some(
        (clause) => entry.organizationId === clause.organizationId,
      )
      if (!matched) return false
    }
    return true
  }

  const prisma = {
    toolRegistryEntry: {
      findFirst: async ({ where }: { where: any }) =>
        options.registry.find((entry) => matchesWhere(entry, where)) ?? null,
    },
    toolGrant: {
      findMany: async () =>
        options.grantAllowed
          ? [
            {
              id: 'grant-1',
              toolId: options.registry[0]?.id ?? 'tool',
              state: 'allowed',
              config: {},
              source: 'role',
              roleId: 'role-1',
              agentId: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]
          : [],
    },
    mcpServerInstance: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        options.instances.find((instance) => instance.id === where.id) ?? null,
    },
    mcpServerCredentialOverride: {
      findUnique: async () => null,
    },
  }

  return prisma as unknown as PrismaClient
}

const INSTANCE_ID = '00000000-0000-4000-8000-0000000000c1'

const MCP_TRANSPORT_CONFIG = {
  transport: 'mcp' as const,
  serverId: INSTANCE_ID,
  toolName: 'do_thing',
}

test(
  'planToolDispatch defaults to NullSecretResolver: opaque credentialRef returns secret: null '
    + 'instead of leaking through EnvSecretResolver',
  async () => {
    // Set the env var that EnvSecretResolver WOULD have read if we had not
    // switched the default. If the default ever regresses to EnvSecretResolver,
    // this test will return 'leaked-plaintext' and the assertion will fail.
    process.env['secret_opaque_ref'] = 'leaked-plaintext'
    try {
      const prisma = buildMcpPrisma({
        registry: [
          {
            id: 'tool-mcp',
            organizationId: ORG_A,
            enabled: true,
            status: 'active',
            transport: 'mcp',
            transportConfig: MCP_TRANSPORT_CONFIG,
            mcpInstanceId: INSTANCE_ID,
          },
        ],
        instances: [
          {
            id: INSTANCE_ID,
            credentialRef: 'secret_opaque_ref',
            lifecycleState: 'active',
            transportConfig: {},
            catalogEntry: { defaultTransportConfig: {} },
          },
        ],
        grantAllowed: true,
      })

      const plan = await planToolDispatch(prisma, 'tool-mcp', {
        organizationId: ORG_A,
        principals: { roleIds: ['role-1'] },
        credentialContext: {},
      })

      assert.equal(plan.transport, 'mcp')
      if (plan.transport !== 'mcp') throw new Error('unreachable')
      // The dispatcher must explicitly produce `null` (not `undefined`) for an
      // opaque ref when no resolver is injected; misconfigured deployments now
      // fail loudly at the transport instead of silently dispatching null.
      assert.strictEqual(plan.secret, null)
    } finally {
      delete process.env['secret_opaque_ref']
    }
  },
)

test('planToolDispatch rejects MCP instances configured for stdio execution', async () => {
  const prisma = buildMcpPrisma({
    registry: [
      {
        id: 'tool-mcp',
        organizationId: ORG_A,
        enabled: true,
        status: 'active',
        transport: 'mcp',
        transportConfig: MCP_TRANSPORT_CONFIG,
        mcpInstanceId: INSTANCE_ID,
      },
    ],
    instances: [
      {
        id: INSTANCE_ID,
        credentialRef: null,
        lifecycleState: 'active',
        transportConfig: { transport: 'stdio', command: 'node' },
        catalogEntry: { defaultTransportConfig: {} },
      },
    ],
    grantAllowed: true,
  })

  await assert.rejects(
    () => planToolDispatch(prisma, 'tool-mcp', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: { organizationId: ORG_A },
    }),
    (error: unknown) =>
      error instanceof ToolDispatchError
      && error.code === TOOL_DISPATCH_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})

test(
  'planToolDispatch uses the injected SecretResolver when options.secretResolver is provided',
  async () => {
    const prisma = buildMcpPrisma({
      registry: [
        {
          id: 'tool-mcp',
          organizationId: ORG_A,
          enabled: true,
          status: 'active',
          transport: 'mcp',
          transportConfig: MCP_TRANSPORT_CONFIG,
          mcpInstanceId: 'instance-1',
        },
      ],
      instances: [
        {
          id: 'instance-1',
          credentialRef: 'secret_opaque_ref',
          lifecycleState: 'active',
          transportConfig: {},
          catalogEntry: { defaultTransportConfig: {} },
        },
      ],
      grantAllowed: true,
    })

    const calls: string[] = []
    const resolver: SecretResolver = {
      async resolve(ref: string) {
        calls.push(ref)
        return 'resolved-plaintext'
      },
    }

    const plan = await planToolDispatch(
      prisma,
      'tool-mcp',
      {
        organizationId: ORG_A,
        principals: { roleIds: ['role-1'] },
        credentialContext: {},
      },
      { secretResolver: resolver },
    )

    assert.equal(plan.transport, 'mcp')
    if (plan.transport !== 'mcp') throw new Error('unreachable')
    assert.equal(plan.secret, 'resolved-plaintext')
    assert.deepEqual(calls, ['secret_opaque_ref'])
  },
)

test('planToolDispatch passes registry lookup when caller org matches', async () => {
  const prisma = buildPrisma([
    {
      id: 'tool-orgA',
      organizationId: ORG_A,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-orgA', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  // Same advance-past-cross-org-check assertion: caller now hits the grant
  // gate, not the tool-not-found gate.
  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.GRANT_DENIED,
  )
})
