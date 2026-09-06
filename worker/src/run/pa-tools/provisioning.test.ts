import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  runAgentBindChannelTool,
  runAgentCreateTool,
  runAgentListTool,
  runAgentTriggerCreateTool,
  runChannelCreateTool,
} from './provisioning.js'

const ORG_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d001'
const PROJECT_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d002'
const TEAM_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d003'
const USER_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d004'
const RUN_CHANNEL_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d005'
const TARGET_CHANNEL_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d006'
const THREAD_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d007'
const AGENT_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d008'
const NEW_CHANNEL_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d009'

const UOA_IDENTITY = {
  subject: 'uoa-subject-1',
  organizationId: 'uoa-org-1',
  teamId: 'uoa-team-1',
  tokenVersion: 3,
}

type PrismaStub = Record<string, unknown>

const buildContext = (
  role: 'owner' | 'admin' | 'member',
  prisma: PrismaStub,
  options: { uoaIdentity?: boolean } = {},
): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: {
        requestId: 'request-1',
        teamId: TEAM_ID,
        ...(options.uoaIdentity ? { uoaIdentity: UOA_IDENTITY } : {}),
      },
      actor: { actorId: USER_ID, actorType: 'user', roles: [role] },
      tenant: {
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
    },
    agentId: 'assistant-1',
    agentKind: 'personal_assistant',
    channel: { id: RUN_CHANNEL_ID, organizationId: ORG_ID },
    ledgerIdentity: null,
    prisma: {
      organizationMember: {
        // `findUnique` resolves the acting member; `findFirst` is the
        // active-membership check the owner stamp runs before creating an agent.
        findFirst: async () => ({ id: 'membership-1' }),
        findUnique: async () => ({ role, deactivatedAt: null }),
      },
      ...prisma,
    },
    realtimeTransport: {},
    run: { id: 'run-1', messageId: 'message-1', threadId: THREAD_ID },
    toolCallId: 'call-1',
  }) as unknown as BuiltinToolRuntimeContext

const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

test('channel_create makes the acting user the owner of a channel in the run team', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = buildContext('member', {
    team: {
      // Read twice: `canPlaceChannelInTeam` selects `systemManaged`, the
      // container lookup selects the project. One superset row serves both.
      findUnique: async () => ({
        project: { id: PROJECT_ID, organizationId: ORG_ID },
        systemManaged: false,
      }),
    },
    // Placing a channel in a team requires standing in it; a plain org member
    // gets that standing from their team membership, not their org role.
    teamMember: { findFirst: async () => ({ role: 'member' }) },
    projectMember: { findFirst: async () => null },
    // `mapChannelRecord` computes `viewerCanManage` through `canManageChannel`,
    // which re-reads the channel row and the creator's channel membership.
    channelMember: { findUnique: async () => ({ role: 'owner' }) },
    channel: {
      findFirst: async () => null,
      findUnique: async () => ({
        id: NEW_CHANNEL_ID,
        organizationId: ORG_ID,
        systemChannelType: null,
        teamId: TEAM_ID,
      }),
      create: async (input: { data: Record<string, unknown> }) => {
        created.push(input.data)
        return {
          id: NEW_CHANNEL_ID,
          label: 'Release planning',
          slug: 'release-planning',
          type: 'standard',
          systemChannelType: null,
          dmKey: null,
          visibility: 'private',
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          teamId: TEAM_ID,
          topic: null,
          description: null,
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          team: { name: 'Core', project: { id: PROJECT_ID, name: 'Nessie' } },
        }
      },
    },
    thread: { findFirst: async () => ({ id: THREAD_ID }) },
    $queryRaw: async () => [],
  })

  const result = await runChannelCreateTool(context, {
    label: 'Release planning',
    visibility: 'private',
  })

  assert.equal(created.length, 1)
  assert.equal(created[0]?.teamId, TEAM_ID)
  assert.deepEqual(created[0]?.members, {
    create: { userId: USER_ID, role: 'owner' },
  })
  assert.match(result.outputPreview, /channelId=4f7d1c00-0e64-4d10-a517-0d0b69c1d009/)
  assert.match(result.outputPreview, /Nessie \/ Core/)
})

test('agent_create refuses a tool policy that grants an explicit-grant tool', async () => {
  let createCalls = 0
  const context = buildContext('member', {
    agent: {
      create: async () => {
        createCalls += 1
        return {}
      },
    },
    toolRegistryEntry: { findMany: async () => [] },
  })

  const message = await rejection(
    runAgentCreateTool(context, {
      name: 'Researcher',
      toolPolicy: { deep_water_run_update: true },
    }),
  )

  assert.match(message, /Explicit-grant tools are managed only from the owner/)
  assert.equal(createCalls, 0)
})

test('agent_create runs the shared avatar seam and survives it failing', async () => {
  const created: Array<Record<string, unknown>> = []
  // No model client on this run: the seam reports and resolves to no avatar,
  // because a picture is never worth failing a creation for.
  const context = buildContext('member', {
    agent: {
      create: async (input: { data: Record<string, unknown> }) => {
        created.push(input.data)
        return {
          ...buildAgentRow({ channelIds: [], id: AGENT_ID, name: 'Researcher', role: 'assistant' }),
          ...input.data,
        }
      },
    },
    toolRegistryEntry: { findMany: async () => [] },
  })

  const result = await runAgentCreateTool(context, { name: 'Researcher' })

  assert.match(result.outputPreview, /Created agent "Researcher"/)
  assert.equal(created.length, 1)
  assert.equal(created[0]?.['avatarAttachmentId'], undefined)
})

const SECOND_AGENT_ID = '4f7d1c00-0e64-4d10-a517-0d0b69c1d012'

// The columns `mapAgentRecord` reads, so the tool sees the same record the
// Agents page renders.
const buildAgentRow = (input: {
  id: string
  name: string
  role: string
  channelIds: string[]
}) => ({
  agentKind: 'shared' as const,
  avatarAttachmentId: null,
  bindings: input.channelIds.map((channelId) => ({ channelId })),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  delegationMode: 'none' as const,
  effort: 'medium' as const,
  id: input.id,
  messages: [],
  model: null,
  name: input.name,
  parentAgentId: null,
  provider: null,
  role: input.role,
  runs: [],
  status: 'idle' as const,
  surfacePolicy: 'shared' as const,
  systemManaged: false,
  systemPrompt: null,
  todosEnabled: false,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  visibility: 'team' as const,
})

test('agent_list gives a member the agents they may see, with the ids bind and trigger need', async () => {
  const queries: Array<Record<string, unknown>> = []
  const context = buildContext('member', {
    agent: {
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args)
        return [
          buildAgentRow({
            channelIds: [TARGET_CHANNEL_ID],
            id: AGENT_ID,
            name: 'Hardware Watch',
            role: 'monitor',
          }),
        ]
      },
    },
    channel: {
      findMany: async () => [{ id: TARGET_CHANNEL_ID, label: 'ops' }],
    },
  })

  const result = await runAgentListTool(context, {})

  // A member reaches an agent through a channel they can see it in, or because
  // they steward it. `agent_list` carries the complete shared document/agent
  // predicate rather than extracting its OR arms, so reachability is nested
  // under the shared visibility fragment.
  const where = queries[0]?.where as {
    AND: Array<Record<string, unknown>>
    OR: Array<{ AND?: Array<{ OR?: Array<Record<string, unknown>> }> }>
    organizationId: string
  }
  assert.equal(where.organizationId, ORG_ID)
  assert.deepEqual(where.AND, [{
    OR: [
      { visibility: 'team' },
      {
        visibility: 'private',
        ownerMembership: { deactivatedAt: null },
        ownerUserId: USER_ID,
        parentAgentId: null,
      },
    ],
  }])
  assert.equal(where.OR.length, 1)
  const reachability = where.OR[0]?.AND?.[0]?.OR ?? []
  assert.deepEqual(
    (reachability[0] as { bindings: { some: { channel: unknown } } }).bindings.some.channel,
    {
      organizationId: ORG_ID,
      OR: [{ visibility: 'public' }, { members: { some: { userId: USER_ID } } }],
    },
  )
  // Ownership widens by pointer equality, so it carries the live-membership
  // join and excludes spawned subtask children.
  assert.deepEqual(reachability[1], {
    ownerMembership: { deactivatedAt: null },
    ownerUserId: USER_ID,
    parentAgentId: null,
  })
  assert.equal(
    reachability.some((branch) => 'bindings' in branch && 'none' in (branch.bindings as object)),
    false,
    'a member must not get the owner-only unbound branch',
  )

  assert.match(result.outputPreview, /Agents \(1\)/)
  assert.match(result.outputPreview, /"Hardware Watch" \| role=monitor/)
  assert.match(result.outputPreview, new RegExp(`agentId=${AGENT_ID}`))
  assert.match(result.outputPreview, new RegExp(`#ops \\(channelId=${TARGET_CHANNEL_ID}\\)`))
})

test('agent_list gives an owner unbound agents too, and narrows on a named one', async () => {
  const queries: Array<Record<string, unknown>> = []
  const context = buildContext('owner', {
    agent: {
      findMany: async (args: Record<string, unknown>) => {
        queries.push(args)
        return [
          buildAgentRow({
            channelIds: [],
            id: AGENT_ID,
            name: 'Hardware Watch',
            role: 'monitor',
          }),
          buildAgentRow({
            channelIds: [],
            id: SECOND_AGENT_ID,
            name: 'Release Reporter',
            role: 'writer',
          }),
        ]
      },
    },
    channel: { findMany: async () => [] },
  })

  const result = await runAgentListTool(context, { query: 'hardware' })

  const where = queries[0]?.where as {
    OR: Array<{ AND?: Array<{ OR?: Array<Record<string, unknown>> }> } & Record<string, unknown>>
  }
  // The owner retains the exact shared channel/stewardship branches and gets
  // two additional routes: any in-org binding and no bindings at all.
  assert.ok(
    where.OR.some(
      (branch) =>
        'bindings' in branch
        && 'none' in (branch.bindings as object),
    ),
    'an owner still reaches unbound agents',
  )
  assert.ok(
    (where.OR[0]?.AND?.[0]?.OR ?? []).some((branch) =>
      (branch as { ownerUserId?: string }).ownerUserId === USER_ID,
    ),
    'the ownership branch is present for an owner too',
  )

  assert.match(result.outputPreview, /Agents \(1\)/)
  assert.match(result.outputPreview, new RegExp(`agentId=${AGENT_ID}`))
  assert.doesNotMatch(result.outputPreview, /Release Reporter/)
  assert.match(result.outputPreview, /not in any channel yet/)
})

test('agent_bind_channel refuses a non-owner and never writes a binding', async () => {
  let upserts = 0
  const context = buildContext('member', {
    channel: {
      findUnique: async () => ({
        systemChannelType: null,
        type: 'standard',
        organizationId: ORG_ID,
        visibility: 'private',
        members: [{ id: 'membership-1' }],
      }),
    },
    agentBinding: {
      upsert: async () => {
        upserts += 1
        return {}
      },
    },
  })

  const message = await rejection(
    runAgentBindChannelTool(context, {
      agentId: AGENT_ID,
      channelId: TARGET_CHANNEL_ID,
    }),
  )

  assert.match(message, /Only an organisation owner can bind an agent to a channel/)
  assert.match(message, /your role is "member"/)
  assert.equal(upserts, 0)
})

test('agent_bind_channel refuses the Personal Assistant DM even for an owner', async () => {
  let upserts = 0
  const context = buildContext('owner', {
    channel: {
      findUnique: async () => ({
        systemChannelType: 'personal_assistant',
        type: 'dm',
        organizationId: ORG_ID,
        visibility: 'private',
        members: [{ id: 'membership-1' }],
      }),
    },
    agentBinding: {
      upsert: async () => {
        upserts += 1
        return {}
      },
    },
  })

  const message = await rejection(
    runAgentBindChannelTool(context, {
      agentId: AGENT_ID,
      channelId: TARGET_CHANNEL_ID,
    }),
  )

  assert.match(message, /cannot be bound to a system-managed conversation/)
  assert.equal(upserts, 0)
})

test('agent_bind_channel honours an explicit policy deny for an owner', async () => {
  let upserts = 0
  const context = buildContext('owner', {
    channel: {
      findUnique: async () => ({
        systemChannelType: null,
        type: 'standard',
        organizationId: ORG_ID,
        visibility: 'private',
        members: [{ id: 'membership-1' }],
      }),
    },
    $queryRaw: async () => [
      {
        action: 'bind',
        actorId: '*',
        actorType: 'role',
        conditions: null,
        effect: 'deny',
        id: 'rule-1',
        priority: 0,
        resourceType: 'agent',
        scope: 'organization',
        scopeId: ORG_ID,
      },
    ],
    agentBinding: {
      upsert: async () => {
        upserts += 1
        return {}
      },
    },
  })

  const message = await rejection(
    runAgentBindChannelTool(context, {
      agentId: AGENT_ID,
      channelId: TARGET_CHANNEL_ID,
    }),
  )

  assert.match(message, /denied by policy: EXPLICIT_DENY/)
  assert.equal(upserts, 0)
})

test('agent_trigger_create refuses a non-owner before touching the agent', async () => {
  let agentReads = 0
  const context = buildContext('admin', {
    agent: {
      count: async () => {
        agentReads += 1
        return 1
      },
    },
  })

  const message = await rejection(
    runAgentTriggerCreateTool(context, {
      agentId: AGENT_ID,
      type: 'manual',
      targetChannelId: TARGET_CHANNEL_ID,
    }),
  )

  assert.match(message, /Only an organisation owner can create a trigger on an agent/)
  assert.equal(agentReads, 0)
})

test('agent_trigger_create stamps launchOrigin with the creator and their UOA team', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = buildContext(
    'owner',
    {
      agent: {
        count: async () => 1,
        findUnique: async () => ({
          id: AGENT_ID,
          agentKind: 'shared',
          organizationId: ORG_ID,
          // `createAgentTrigger` selects this to refuse a global-agent target.
          systemSlug: null,
        }),
      },
      team: { findFirst: async () => ({ id: TEAM_ID }) },
      agentBinding: { findFirst: async () => ({ id: 'binding-1' }) },
      thread: { findFirst: async () => ({ id: THREAD_ID }) },
      agentTrigger: {
        create: async (input: { data: Record<string, unknown> }) => {
          created.push(input.data)
          return {
            agentId: AGENT_ID,
            config: input.data.config,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            description: null,
            enabled: true,
            id: '4f7d1c00-0e64-4d10-a517-0d0b69c1d010',
            lastFiredAt: null,
            name: 'Daily digest',
            nextRunAt: input.data.nextRunAt as Date,
            status: 'active',
            targetChannelId: TARGET_CHANNEL_ID,
            targetThreadId: THREAD_ID,
            type: 'scheduled',
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            workflowInstallationId: null,
          }
        },
      },
    },
    { uoaIdentity: true },
  )

  const result = await runAgentTriggerCreateTool(context, {
    agentId: AGENT_ID,
    type: 'scheduled',
    name: 'Daily digest',
    config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'Summarise yesterday' },
    targetChannelId: TARGET_CHANNEL_ID,
  })

  assert.equal(created.length, 1)
  const config = created[0]?.config as Record<string, unknown>
  assert.equal(config.createdByUserId, USER_ID)
  assert.deepEqual(config.launchOrigin, {
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    uoaIdentity: UOA_IDENTITY,
    userId: USER_ID,
  })
  assert.ok(created[0]?.nextRunAt instanceof Date)
  assert.match(result.outputPreview, /triggerId=4f7d1c00-0e64-4d10-a517-0d0b69c1d010/)
})

test('agent_trigger_create keeps a caller-supplied launchOrigin out of the stored config', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = buildContext('owner', {
    agent: {
      count: async () => 1,
      findUnique: async () => ({
        id: AGENT_ID,
        agentKind: 'shared',
        organizationId: ORG_ID,
        systemSlug: null,
      }),
    },
    agentBinding: { findFirst: async () => ({ id: 'binding-1' }) },
    thread: { findFirst: async () => ({ id: THREAD_ID }) },
    agentTrigger: {
      create: async (input: { data: Record<string, unknown> }) => {
        created.push(input.data)
        return {
          agentId: AGENT_ID,
          config: input.data.config,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          description: null,
          enabled: true,
          id: '4f7d1c00-0e64-4d10-a517-0d0b69c1d011',
          lastFiredAt: null,
          name: null,
          nextRunAt: null,
          status: 'active',
          targetChannelId: TARGET_CHANNEL_ID,
          targetThreadId: THREAD_ID,
          type: 'manual',
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          workflowInstallationId: null,
        }
      },
    },
  })

  await runAgentTriggerCreateTool(context, {
    agentId: AGENT_ID,
    type: 'manual',
    targetChannelId: TARGET_CHANNEL_ID,
    config: {
      prompt: 'Do the thing',
      // A model-authored config must not be able to claim who a future run acts as.
      launchOrigin: { organizationId: ORG_ID, teamId: TEAM_ID, userId: USER_ID },
      createdByUserId: USER_ID,
    },
  })

  const config = created[0]?.config as Record<string, unknown>
  assert.deepEqual(config, { prompt: 'Do the thing' })
})
