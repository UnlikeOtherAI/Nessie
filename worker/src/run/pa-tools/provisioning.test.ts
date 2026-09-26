import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAgentToolCatalog } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { PEER_PROJECT_TOOL_IDS, resolveProjectDelegatedToolIds } from '../execute/run-setup.js'
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
      organization: { findUnique: async () => ({ externalOrgId: null }) },
      organizationMember: {
        // `findUnique` resolves the acting member; `findFirst` is the
        // active-membership check the owner stamp runs before creating an agent.
        findFirst: async () => ({ id: 'membership-1' }),
        findUnique: async () => ({ role, deactivatedAt: null }),
      },
      productAccountLink: { findUnique: async () => null },
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
      // explicit project resolver selects the canonical project. One superset
      // row serves both.
      findUnique: async () => ({
        project: { id: PROJECT_ID, organizationId: ORG_ID },
        projects: [{ id: PROJECT_ID, organizationId: ORG_ID }],
        systemManaged: false,
      }),
    },
    // One superset row: the explicit project resolver reads `teamId`, and
    // placement reads `channelRoot` to know it is a real project.
    project: {
      count: async () => 1,
      findUnique: async () => ({ channelRoot: false, teamId: TEAM_ID }),
    },
    // Placing a channel in a team requires standing in it; a plain org member
    // gets that standing from their team membership, not their org role.
    teamMember: { findFirst: async () => ({ role: 'member' }) },
    // Adding a room to an existing project changes that project, so the acting
    // user must be a member of it (`canModifyProject`).
    projectMember: { count: async () => 1, findFirst: async () => null },
    // `mapChannelRecord` computes `viewerCanManage` through `canModifyChannel`,
    // which re-reads the channel row and the creator's channel membership.
    channelMember: {
      findUnique: async () => ({ role: 'owner' }),
      // `mapChannelRecord` answers `viewerIsMember` for the composer with a
      // count. The creator is in the channel they just made.
      count: async () => 1,
    },
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
          visibility: 'protected',
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          project: { channelRoot: false, id: PROJECT_ID, name: 'Nessie' },
          teamId: TEAM_ID,
          topic: null,
          description: null,
          archivedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          team: { name: 'Core' },
        }
      },
    },
    thread: { findFirst: async () => ({ id: THREAD_ID }) },
    $queryRaw: async () => [],
  })

  const result = await runChannelCreateTool(context, {
    label: 'Release planning',
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    visibility: 'protected',
  })

  assert.equal(created.length, 1)
  assert.equal(created[0]?.teamId, TEAM_ID)
  assert.deepEqual(created[0]?.members, {
    create: { userId: USER_ID, role: 'owner' },
  })
  assert.match(result.outputPreview, /Nessie \/ Core/)
  // A link the Designer can hand over as it is; the id the next call takes is
  // its last segment, so no raw `channelId=` beside it, and no instruction
  // addressed to the model.
  assert.match(
    result.outputPreview,
    /\[#[^\]]+\]\(\/channels\/4f7d1c00-0e64-4d10-a517-0d0b69c1d009\)/,
  )
  assert.doesNotMatch(result.outputPreview, /channelId=|agent_bind_channel/)
  assert.match(result.outputPreview, /^slug=release-planning \| visibility=protected$/m)
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

  // The refusal names the path that works — create, then grant with
  // agent_tool_access_set — rather than an owner surface the Designer would
  // relay as "not something I can do here".
  assert.match(message, /Explicit-grant tools are not tool-policy keys/)
  assert.match(message, /agent_tool_access_set/)
  assert.equal(createCalls, 0)
})

// F11 end to end: the catalogue the Designer reads says how to give a board
// tool, agent_create stores what it was told, and run setup lends exactly
// that in the agent's project channel. The catalogue once called these "on by
// default", so a Designer that followed it wrote nothing and built a CTO with
// no ticket tools at all.
test('a Designer-built agent that works a board is created holding the board tools', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = buildContext('member', {
    agent: {
      create: async (input: { data: Record<string, unknown> }) => {
        created.push(input.data)
        return {
          ...buildAgentRow({ channelIds: [], id: AGENT_ID, name: 'CTO', role: 'cto' }),
          ...input.data,
        }
      },
      findFirst: async () => ({
        id: AGENT_ID,
        name: 'CTO',
        projectId: PROJECT_ID,
        speakingStyle: null,
        systemManaged: false,
        systemPrompt: null,
      }),
    },
    agentCoreDocumentMigration: {
      // Core provisioning is covered by its own suites; this catalogue test
      // starts from an already-complete required document pair.
      findUnique: async () => ({ documentCount: 2 }),
    },
    toolRegistryEntry: { findMany: async () => [] },
  })

  const catalogue = await loadAgentToolCatalog(context.prisma, { organizationId: ORG_ID })
  const boardTools = catalogue.togglable.filter((entry) => entry.projectChannelOnly)
  assert.ok(boardTools.some((entry) => entry.key === 'ticket_create'))
  // Following the catalogue: an allow-mode key is granted by writing `true`,
  // a deny-mode one by writing nothing.
  const toolPolicy = Object.fromEntries(
    boardTools.filter((entry) => entry.allowMode).map((entry) => [entry.key, true]),
  )
  assert.equal(Object.keys(toolPolicy).length, boardTools.length)

  const originalWarn = console.warn
  console.warn = () => undefined
  try {
    await runAgentCreateTool(context, { name: 'CTO', role: 'cto', toolPolicy })
  } finally {
    console.warn = originalWarn
  }

  const stored = created[0]?.['toolPolicy'] as Record<string, boolean>
  const lent = resolveProjectDelegatedToolIds(true, stored)
  for (const entry of boardTools) {
    assert.equal(stored[entry.key], true, `${entry.key} is granted`)
    assert.equal(lent.has(entry.key), PEER_PROJECT_TOOL_IDS.has(entry.key), `${entry.key} is lent`)
  }
  assert.ok(lent.has('ticket_create'))
  assert.equal(resolveProjectDelegatedToolIds(true, {}).size, 0, 'an unwritten grant lends nothing')
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
      findFirst: async () => ({
        id: AGENT_ID,
        name: 'Researcher',
        projectId: PROJECT_ID,
        speakingStyle: null,
        systemManaged: false,
        systemPrompt: null,
      }),
    },
    agentCoreDocumentMigration: {
      // Core provisioning is covered end to end in the knowledge/API suites;
      // this avatar-seam unit starts from the idempotent completed state.
      findUnique: async () => ({ documentCount: 2 }),
    },
    toolRegistryEntry: { findMany: async () => [] },
  })

  const logged: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { logged.push(args) }
  let result
  try {
    result = await runAgentCreateTool(context, { name: 'Researcher' })
  } finally {
    console.warn = originalWarn
  }

  assert.match(result.outputPreview, /Created agent \[Researcher\]/)
  assert.equal(created.length, 1)
  assert.equal(created[0]?.['avatarAttachmentId'], undefined)
  // And it SAYS so. A silent seam is what left a person looking at a blank
  // tile with the agent that built it unable to explain why. The reason is
  // data here; "quote it word for word" is the Designer prompt's rule, because
  // written into this output it was relayed to the person as it stood.
  assert.match(result.outputPreview, /^portrait: none \(reason: "The model service is not configured\."\)$/m)
  assert.doesNotMatch(result.outputPreview, /word for word|Tell them/)
  // A person is handed links, not the UUIDs the tool used to print.
  assert.match(result.outputPreview, new RegExp(`\\[Researcher\\]\\(/admin/agents/${AGENT_ID}\\)`))
  assert.doesNotMatch(result.outputPreview, /agentId=|channelId=/)
  assert.match(result.outputPreview, /^Lives in: nowhere yet — add it to any channel\.$/m)
  // And an operator can read it without the chat transcript, exactly as
  // `POST /api/agents` already logs it.
  assert.equal(logged.length, 1)
  assert.match(String(logged[0]?.[0]), /\[worker\.agent-avatar\] generation failed for "Researcher"/)
  assert.match(String(logged[0]?.[1]), /model service is not configured/)
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

  // Each row is links a person can be handed; the ids bind and trigger take
  // are their last segments, and no raw `key=<uuid>` is left.
  assert.match(result.outputPreview, /Agents \(1\)/)
  assert.equal(
    result.outputPreview.split('\n')[1],
    `- [Hardware Watch](/admin/agents/${AGENT_ID}) | role=monitor | [#ops](/channels/${TARGET_CHANNEL_ID})`,
  )
  assert.doesNotMatch(result.outputPreview, /agentId=|channelId=/)
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
  assert.match(
    result.outputPreview,
    new RegExp(`^- \\[Hardware Watch\\]\\(/admin/agents/${AGENT_ID}\\) \\| role=monitor \\| not in any channel yet$`, 'm'),
  )
  assert.doesNotMatch(result.outputPreview, /Release Reporter/)
})

test('agent_bind_channel refuses a non-owner and never writes a binding', async () => {
  let upserts = 0
  const context = buildContext('member', {
    channel: {
      findUnique: async () => ({
        systemChannelType: null,
        type: 'standard',
        organizationId: ORG_ID,
        // A standard room is never stored `private` after the visibility
        // backfill; `protected` is the non-public value it moved to.
        visibility: 'protected',
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
        // A standard room is never stored `private` after the visibility
        // backfill; `protected` is the non-public value it moved to.
        visibility: 'protected',
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
        // One superset row: `createAgentTrigger` selects `systemSlug` to
        // refuse a global-agent target, the output names the agent.
        findUnique: async () => ({
          id: AGENT_ID,
          agentKind: 'shared',
          name: 'Hardware Watch',
          organizationId: ORG_ID,
          systemSlug: null,
          visibility: 'team',
        }),
      },
      // The room the trigger posts into, named in the output.
      channel: { findFirst: async () => ({ id: TARGET_CHANNEL_ID, label: 'ops', type: 'standard', visibility: 'public' }) },
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
  // The trigger, the agent it fires and the room it posts into, as links; the
  // triggerId agent_trigger_update takes is the first link's last segment.
  const [headline, detail] = result.outputPreview.split('\n')
  assert.equal(
    headline,
    'Created scheduled trigger [Daily digest](/admin/automations/triggers/4f7d1c00-0e64-4d10-a517-0d0b69c1d010)'
    + ` for [Hardware Watch](/admin/agents/${AGENT_ID})`,
  )
  assert.match(
    detail ?? '',
    new RegExp(`^status=active \\| next run .+ \\| posts into \\[#ops\\]\\(/channels/${TARGET_CHANNEL_ID}\\)$`),
  )
  assert.doesNotMatch(result.outputPreview, /triggerId=|channelId=|agentId=/)
})

test('agent_trigger_create links a trigger without a name by its type', async () => {
  const context = buildContext('owner', {
    agent: {
      count: async () => 1,
      findUnique: async () => ({
        agentKind: 'shared',
        id: AGENT_ID,
        name: 'Hardware Watch',
        organizationId: ORG_ID,
        systemSlug: null,
        visibility: 'team',
      }),
    },
    channel: { findFirst: async () => ({ id: TARGET_CHANNEL_ID, label: 'ops', type: 'standard', visibility: 'public' }) },
    agentBinding: { findFirst: async () => ({ id: 'binding-1' }) },
    thread: { findFirst: async () => ({ id: THREAD_ID }) },
    agentTrigger: {
      create: async (input: { data: Record<string, unknown> }) => ({
        agentId: AGENT_ID,
        config: input.data.config,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        description: null,
        enabled: true,
        id: '4f7d1c00-0e64-4d10-a517-0d0b69c1d013',
        lastFiredAt: null,
        name: null,
        nextRunAt: null,
        status: 'active',
        targetChannelId: TARGET_CHANNEL_ID,
        targetThreadId: THREAD_ID,
        type: 'manual',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        workflowInstallationId: null,
      }),
    },
  })

  const result = await runAgentTriggerCreateTool(context, {
    agentId: AGENT_ID,
    type: 'manual',
    targetChannelId: TARGET_CHANNEL_ID,
    config: { prompt: 'Do the thing' },
  })

  assert.equal(
    result.outputPreview,
    'Created [manual trigger](/admin/automations/triggers/4f7d1c00-0e64-4d10-a517-0d0b69c1d013)'
    + ` for [Hardware Watch](/admin/agents/${AGENT_ID})\n`
    + `status=active | posts into [#ops](/channels/${TARGET_CHANNEL_ID})`,
  )
})

// `createAgentTrigger` checks only that the agent is bound to the room, and
// resolves a thread's room server-side; nothing there asks whether the caller
// can see it. So the room's name is read through the caller's own channel
// visibility: an owner outside a private room gets a link without its name and
// no stamp, and a room they are in is named and stamped as agent_list would.
test('agent_trigger_create names, and stamps, only a room the caller can see', async () => {
  const run = async (room: { id: string; label: string; type: string; visibility: string } | null) => {
    const sink = createConsumedSourceSink()
    const lookups: unknown[] = []
    const context = {
      ...buildContext('owner', {
        agent: {
          count: async () => 1,
          findUnique: async () => ({
            agentKind: 'shared',
            id: AGENT_ID,
            name: 'Hardware Watch',
            organizationId: ORG_ID,
            systemSlug: null,
            visibility: 'team',
          }),
        },
        channel: {
          findFirst: async (input: { where: unknown }) => {
            lookups.push(input.where)
            return room
          },
        },
        agentBinding: { findFirst: async () => ({ id: 'binding-1' }) },
        // Only a thread is named; its room is resolved server-side.
        thread: {
          findFirst: async () => ({ id: THREAD_ID }),
          findUnique: async () => ({ channelId: TARGET_CHANNEL_ID }),
        },
        agentTrigger: {
          create: async (input: { data: Record<string, unknown> }) => ({
            agentId: AGENT_ID,
            config: input.data.config,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            description: null,
            enabled: true,
            id: '4f7d1c00-0e64-4d10-a517-0d0b69c1d014',
            lastFiredAt: null,
            name: null,
            nextRunAt: null,
            status: 'active',
            targetChannelId: TARGET_CHANNEL_ID,
            targetThreadId: THREAD_ID,
            type: 'manual',
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            workflowInstallationId: null,
          }),
        },
      }),
      consumedSources: sink,
    } as BuiltinToolRuntimeContext
    const result = await runAgentTriggerCreateTool(context, {
      agentId: AGENT_ID,
      config: { prompt: 'Do the thing' },
      targetThreadId: THREAD_ID,
      type: 'manual',
    })
    return { detail: result.outputPreview.split('\n')[1], lookups, scopes: sink.list() }
  }

  const unseen = await run(null)
  assert.equal(unseen.detail, `status=active | posts into [#channel](/channels/${TARGET_CHANNEL_ID})`)
  assert.deepEqual(unseen.scopes, [], 'a room the caller cannot see stamps nothing')
  assert.deepEqual(unseen.lookups, [{
    AND: [
      {
        OR: [{ visibility: 'public' }, { members: { some: { userId: USER_ID } } }],
        deletedAt: null,
        organizationId: ORG_ID,
      },
      { id: TARGET_CHANNEL_ID },
    ],
  }])

  const seen = await run({ id: TARGET_CHANNEL_ID, label: 'leadership', type: 'standard', visibility: 'protected' })
  assert.equal(seen.detail, `status=active | posts into [#leadership](/channels/${TARGET_CHANNEL_ID})`)
  assert.deepEqual(seen.scopes, [{ scopeId: TARGET_CHANNEL_ID, scopeType: 'channel' }])
})

test('agent_trigger_create keeps a caller-supplied launchOrigin out of the stored config', async () => {
  const created: Array<Record<string, unknown>> = []
  const context = buildContext('owner', {
    agent: {
      count: async () => 1,
      findUnique: async () => ({
        id: AGENT_ID,
        agentKind: 'shared',
        name: 'Hardware Watch',
        organizationId: ORG_ID,
        systemSlug: null,
        visibility: 'team',
      }),
    },
    channel: { findFirst: async () => ({ id: TARGET_CHANNEL_ID, label: 'ops', type: 'standard', visibility: 'public' }) },
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

  // The only identity key stored is the server's own authorship stamp, taken
  // from the acting member rather than the model's config. It grants nothing:
  // a manual fire still runs as the agent.
  const config = created[0]?.config as Record<string, unknown>
  assert.deepEqual(config, { authorUserId: USER_ID, prompt: 'Do the thing' })
})
