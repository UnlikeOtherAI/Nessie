import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from '../src/run/execute/disclosure-basis.js'
import {
  runAgentAvatarGenerateTool,
  runAgentAvatarUpdateTool,
  runAgentReadTool,
  runAgentToolCatalogTool,
  runAgentUpdateTool,
} from '../src/run/pa-tools/agent-config.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

/**
 * The Agent Designer's configuration tools, driven against a real database.
 *
 * These tools exist to do from chat exactly what a person does by clicking, so
 * what matters is that they inherit the SAME refusals — `canEditAgent` and its
 * two narrower field gates, the blueprint-managed refusal, the protected
 * policy-key gate — rather than a second rule that agrees today. A cast Prisma
 * fake would prove the query shape and nothing about the rule.
 *
 * Seed-scoped: this database is shared with concurrently-running suites, so
 * nothing here deletes or counts globally, and the tools touch no queue.
 */

const suite = 'c94f'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const channelId = `00000000-0000-4000-8000-${suite}00000004`
const designerChannelId = `00000000-0000-4000-8000-${suite}00000005`
const threadId = `00000000-0000-4000-8000-${suite}00000006`

const stewardUserId = `00000000-0000-4000-8000-${suite}00000010`
const otherMemberUserId = `00000000-0000-4000-8000-${suite}00000011`
const orgOwnerUserId = `00000000-0000-4000-8000-${suite}00000012`

const personOwnedAgentId = `00000000-0000-4000-8000-${suite}00000020`
const teamOwnedAgentId = `00000000-0000-4000-8000-${suite}00000021`
const designerAgentId = `00000000-0000-4000-8000-${suite}00000022`

const userIds = [stewardUserId, otherMemberUserId, orgOwnerUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `designer-tools-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Designer tools ${index}`,
      email: `designer-tools-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, role: 'member', userId: stewardUserId },
      { organizationId: orgId, role: 'member', userId: otherMemberUserId },
      { organizationId: orgId, role: 'owner', userId: orgOwnerUserId },
    ],
  })
  await prisma.project.create({
    data: { id: projectId, name: `p-${suite}`, organizationId: orgId },
  })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.createMany({
    data: [
      {
        id: channelId,
        label: `pub-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `pub-${suite}`,
        teamId,
        visibility: 'public',
      },
      {
        id: designerChannelId,
        label: `designer-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `designer-${suite}`,
        teamId,
        visibility: 'public',
      },
    ],
  })
  await prisma.thread.create({
    data: { channelId: designerChannelId, id: threadId, title: `t-${suite}` },
  })
  await prisma.agent.createMany({
    data: [
      {
        id: personOwnedAgentId,
        name: `Person owned ${suite}`,
        organizationId: orgId,
        ownerUserId: stewardUserId,
        projectId,
        role: 'assistant',
        systemPrompt: 'Original instructions.',
        teamId,
      },
      {
        id: teamOwnedAgentId,
        name: `Team owned ${suite}`,
        organizationId: orgId,
        projectId,
        role: 'assistant',
        teamId,
      },
      {
        id: designerAgentId,
        name: `Agent Designer ${suite}`,
        organizationId: orgId,
        role: 'agent designer',
        systemManaged: true,
        systemPrompt: 'Blueprint instructions.',
      },
    ],
  })
  await prisma.agentBinding.createMany({
    data: [
      { agentId: personOwnedAgentId, channelId },
      { agentId: teamOwnedAgentId, channelId },
    ],
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.agentBinding.deleteMany({
    where: { channelId: { in: [channelId, designerChannelId] } },
  })
  await prisma.thread.deleteMany({ where: { id: threadId } })
  await prisma.agent.deleteMany({ where: { organizationId: orgId } })
  await prisma.channel.deleteMany({ where: { id: { in: [channelId, designerChannelId] } } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

const buildContext = (
  prisma: PrismaClient,
  userId: string,
): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: { requestId: `request-${suite}`, teamId },
      actor: { actorId: userId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: orgId, projectId, teamId },
    },
    agentId: designerAgentId,
    agentKind: 'shared',
    channel: {
      id: designerChannelId,
      organizationId: orgId,
      systemChannelType: 'system_agent',
    },
    consumedSources: createConsumedSourceSink(),
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {},
    run: { id: `run-${suite}`, interactive: true, messageId: `message-${suite}`, threadId },
    toolCallId: `call-${suite}`,
  }) as unknown as BuiltinToolRuntimeContext

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

dbTest('agent_read returns configuration and stamps the agent scope', async () => {
  await withDb(async (prisma) => {
    const context = buildContext(prisma, otherMemberUserId)
    const result = await runAgentReadTool(context, { agentId: personOwnedAgentId })
    assert.match(result.outputPreview, /Original instructions\./)
    assert.match(result.outputPreview, /owner: Designer tools 0 \(active\)/)
    // The read is a scoped source: what the Designer says next inherits it.
    assert.deepEqual(context.consumedSources?.list(), [
      { scopeId: personOwnedAgentId, scopeType: 'agent' },
    ])
  })
})

dbTest('agent_read on a blueprint agent answers config-only', async () => {
  await withDb(async (prisma) => {
    const result = await runAgentReadTool(buildContext(prisma, otherMemberUserId), {
      agentId: designerAgentId,
    })
    assert.match(result.outputPreview, /Blueprint instructions\./)
    assert.match(result.outputPreview, /managed by Nessie itself/)
    // Activity and other people's channels are not in the projection at all.
    assert.doesNotMatch(result.outputPreview, /channels:/)
  })
})

dbTest('agent_read cannot reach an agent the person could not list', async () => {
  await withDb(async (prisma) => {
    const hidden = await prisma.agent.create({
      data: {
        name: `Private ${suite}`,
        organizationId: orgId,
        ownerUserId: stewardUserId,
        role: 'assistant',
        visibility: 'private',
      },
    })
    assert.match(
      await refusal(
        runAgentReadTool(buildContext(prisma, otherMemberUserId), { agentId: hidden.id }),
      ),
      /not found/i,
    )
  })
})

dbTest('agent_update rewrites only the fields it was given', async () => {
  await withDb(async (prisma) => {
    const result = await runAgentUpdateTool(buildContext(prisma, stewardUserId), {
      agentId: personOwnedAgentId,
      systemPrompt: 'Rewritten instructions.',
    })
    assert.match(result.outputPreview, /Updated agent/)
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: personOwnedAgentId } })
    assert.equal(stored.systemPrompt, 'Rewritten instructions.')
    assert.equal(stored.name, `Person owned ${suite}`)
    assert.equal(stored.role, 'assistant')
  })
})

dbTest('agent_update inherits every refusal canEditAgent makes', async () => {
  await withDb(async (prisma) => {
    // Not this person's agent, and they are not an organisation owner.
    assert.match(
      await refusal(
        runAgentUpdateTool(buildContext(prisma, otherMemberUserId), {
          agentId: personOwnedAgentId,
          name: 'Hijacked',
        }),
      ),
      /owned by Designer tools 0/,
    )

    // A team-owned agent IS editable by an entitled member — the deliberate
    // widening — but claiming it is not.
    await runAgentUpdateTool(buildContext(prisma, otherMemberUserId), {
      agentId: teamOwnedAgentId,
      role: 'analyst',
    })
    assert.match(
      await refusal(
        runAgentUpdateTool(buildContext(prisma, otherMemberUserId), {
          agentId: teamOwnedAgentId,
          ownerUserId: otherMemberUserId,
        }),
      ),
      /owner or an organisation owner/,
    )

    // `todosEnabled` keeps its narrower organisation-owner gate.
    assert.match(
      await refusal(
        runAgentUpdateTool(buildContext(prisma, otherMemberUserId), {
          agentId: teamOwnedAgentId,
          todosEnabled: true,
        }),
      ),
      /organisation owners/,
    )

    // Explicit-grant keys are server-owned for every editor, owners included.
    assert.match(
      await refusal(
        runAgentUpdateTool(buildContext(prisma, orgOwnerUserId), {
          agentId: teamOwnedAgentId,
          toolPolicy: { deep_water_run_update: true },
        }),
      ),
      /deep_water_run_update|explicit/i,
    )

    // A blueprint-managed agent is refused in words, not as a crash.
    const systemRefusal = await refusal(
      runAgentUpdateTool(buildContext(prisma, orgOwnerUserId), {
        agentId: designerAgentId,
        name: 'Rebranded',
      }),
    )
    assert.match(systemRefusal, /built-in agents/)
    assert.match(systemRefusal, /nobody/)
  })
})

dbTest('agent_avatar_update follows the same edit authority', async () => {
  await withDb(async (prisma) => {
    assert.match(
      await refusal(
        runAgentAvatarUpdateTool(buildContext(prisma, otherMemberUserId), {
          agentId: personOwnedAgentId,
          avatarAttachmentId: null,
        }),
      ),
      /owned by Designer tools 0/,
    )
    const cleared = await runAgentAvatarUpdateTool(buildContext(prisma, stewardUserId), {
      agentId: personOwnedAgentId,
      avatarAttachmentId: null,
    })
    assert.match(cleared.outputPreview, /Cleared the portrait/)
    assert.match(
      await refusal(
        runAgentAvatarUpdateTool(buildContext(prisma, orgOwnerUserId), {
          agentId: designerAgentId,
          avatarAttachmentId: null,
        }),
      ),
      /managed by Nessie itself/,
    )
  })
})

dbTest('agent_tool_catalog names the keys and the tools nobody may grant', async () => {
  await withDb(async (prisma) => {
    const result = await runAgentToolCatalogTool(buildContext(prisma, otherMemberUserId), {})
    assert.match(result.outputPreview, /key=web_search/)
    assert.match(result.outputPreview, /Not grantable from a conversation/)
    assert.match(result.outputPreview, /own Personal Assistant may use it/)
    assert.match(result.outputPreview, /owner surfaces \(Apps, Integrations\)/)
    // A narrowing query filters an already-authorized list.
    const narrowed = await runAgentToolCatalogTool(
      buildContext(prisma, otherMemberUserId),
      { query: 'web_search' },
    )
    assert.match(narrowed.outputPreview, /key=web_search/)
    assert.doesNotMatch(narrowed.outputPreview, /key=card_post/)
  })
})

dbTest('a deactivated member gets nothing, read tools included', async () => {
  await withDb(async (prisma) => {
    await prisma.organizationMember.update({
      data: { deactivatedAt: new Date() },
      where: {
        organizationId_userId: { organizationId: orgId, userId: otherMemberUserId },
      },
    })
    assert.match(
      await refusal(
        runAgentReadTool(buildContext(prisma, otherMemberUserId), {
          agentId: teamOwnedAgentId,
        }),
      ),
      /not active/,
    )
    assert.match(
      await refusal(
        runAgentToolCatalogTool(buildContext(prisma, otherMemberUserId), {}),
      ),
      /not active/,
    )
  })
})

dbTest('agent_avatar_generate asks the edit question before it spends anything', async () => {
  await withDb(async (prisma) => {
    // Drawing a portrait is a billed Ledger call, so the authority check has to
    // come first — the same order `POST /api/agents/:id/avatar/generate` uses.
    // Each of these refusals happens with a model client present, so what stops
    // them is authority and not a missing dependency.
    const withModel = (userId: string) => {
      const context = buildContext(prisma, userId)
      return Object.assign(context, {
        modelClient: {
          chat: async () => {
            throw new Error('no generation may be attempted here')
          },
        },
      })
    }

    assert.match(
      await refusal(
        runAgentAvatarGenerateTool(withModel(otherMemberUserId), {
          agentId: personOwnedAgentId,
        }),
      ),
      /owned by Designer tools 0/,
    )
    // A built-in agent is `Agent not found` here, not the
    // "managed by Nessie itself" wording `agent_avatar_update` gives: the
    // generate route runs `isAgentAccessibleToActor` before it asks about
    // edit authority, and a system-managed agent fails that read. Mirroring
    // the route exactly — no weaker, no stronger — is the rule; agreeing with
    // the sibling tool's phrasing is not.
    assert.match(
      await refusal(
        runAgentAvatarGenerateTool(withModel(orgOwnerUserId), {
          agentId: designerAgentId,
        }),
      ),
      /Agent not found/,
    )
    // An agent in another organisation is not found, never "you may not".
    assert.match(
      await refusal(
        runAgentAvatarGenerateTool(withModel(stewardUserId), {
          agentId: '00000000-0000-4000-8000-ffff00000001',
        }),
      ),
      /Agent not found/,
    )
  })
})

dbTest('agent_avatar_generate says a deployment cannot draw rather than failing quietly', async () => {
  await withDb(async (prisma) => {
    // The steward may edit this agent, so the only thing left to refuse on is
    // the missing image capability — and the person hears why.
    const message = await refusal(
      runAgentAvatarGenerateTool(buildContext(prisma, stewardUserId), {
        agentId: personOwnedAgentId,
      }),
    )
    assert.match(message, /Image generation is not configured/)
    const unchanged = await prisma.agent.findUnique({
      where: { id: personOwnedAgentId },
      select: { avatarAttachmentId: true },
    })
    assert.equal(unchanged?.avatarAttachmentId, null)
  })
})

