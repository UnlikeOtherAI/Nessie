import assert from 'node:assert/strict'

import type { PrismaClient, Prisma } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import { createAgentTrigger } from '@nessie/team-admin'

import { hashPassword } from '../src/auth/password.js'

/**
 * One organisation for the standing-policy route suites: an author and a
 * colleague on a project with a ticket trigger the author set up, and two of
 * the author's private machines — Minis, with a reviewed coding-sessions
 * bridge, and Bare, without one. Not a test file itself.
 */

export const PASSWORD = 'correct horse battery staple'

export const seedStandingPolicyRoutes = async (prisma: PrismaClient, suffix: string) => {
  const organization = await prisma.organization.create({ data: { name: `standing-routes-${suffix}` } })
  const organizationId = organization.id
  const [author, colleague] = await Promise.all(['Ondrej', 'Colleague'].map(async (displayName) => prisma.user.create({
    data: {
      displayName, email: `${displayName.toLowerCase()}-${suffix}@example.test`, passwordHash: await hashPassword(PASSWORD),
    },
  })))
  await prisma.organizationMember.createMany({
    data: [author!, colleague!].map((user) => ({ organizationId, role: 'member' as const, userId: user.id })),
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId } })
  await prisma.projectMember.createMany({
    data: [author!, colleague!].map((user) => ({ projectId: project.id, role: 'member' as const, userId: user.id })),
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId, position: 0, projectId: project.id },
  })
  for (const [name, category, position] of [['Backlog', 'todo', 0], ['In progress', 'in_progress', 1], ['Done', 'done', 2]] as const) {
    await prisma.boardColumn.create({ data: { boardId: board.id, category, name, organizationId, position } })
  }
  const channel = await prisma.channel.create({
    data: {
      label: 'eng', organizationId, projectId: project.id, slug: `eng-${suffix}`, teamId: team.id, visibility: 'public',
    },
  })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId, projectId: project.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await createAgentTrigger(prisma, agent.id, {
    config: { instructions: { general: 'Have Claude fix it.' }, pickup: { columns: [{ name: 'In progress' }] } },
    name: 'Pick up tickets',
    targetChannelId: channel.id,
    type: 'ticket_changed',
  }, { authorUserId: author!.id })
  assert.ok(trigger)
  const machine = async (label: string, codingSessions: Record<string, unknown> | null) => {
    const descriptor = ExecutorCapabilityDescriptorSchema.parse({
      ...(codingSessions ? { codingSessions, mcpServers: ['coding-sessions'] } : {}),
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
      localPolicyDigest: `sha256:${'1'.repeat(64)}`,
      operationKeys: ['mcp.tools', 'mcp.call'],
      platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
      profiles: ['workspace_sandbox'],
      protocolVersion: 1,
      revision: 1,
      sandboxBackend: 'none',
      supervisor: 'service',
    })
    return (await prisma.executor.create({
      data: {
        capabilityRevisions: {
          create: {
            descriptor: descriptor as unknown as Prisma.InputJsonValue, localPolicyDigest: descriptor.localPolicyDigest,
            reviewStatus: 'active', revision: 1, signature: 'reviewed',
          },
        },
        label, lastSeenAt: new Date(), organizationId, pairingOwnerUserId: author!.id,
        privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: author!.id } },
        profiles: ['workspace_sandbox'], scopeKind: 'private', status: 'online',
      },
    })).id
  }
  const minis = await machine('Minis', {
    agents: ['claude'], allowedToolCount: 2, configDigest: `sha256:${'c'.repeat(64)}`, environmentNames: [],
    maxBudgetUsd: { claude: 5 }, maxLiveSessionsPerOwner: 3,
    mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
    unaskedCommands: 'listed',
    permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
  })
  const bare = await machine('Bare', null)
  return {
    agentId: agent.id, authorId: author!.id, bare, colleagueId: colleague!.id, minis, organizationId,
    projectId: project.id, teamId: team.id, triggerId: trigger.id,
  }
}
