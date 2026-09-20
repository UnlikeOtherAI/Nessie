import { randomUUID } from 'node:crypto'

export const seedDesignerFixture = async (prisma, seedScope) => {
  const scope = await seedScope(prisma, 'designer-capabilities')
  const sessionId = randomUUID()
  await prisma.organizationMember.create({
    data: { organizationId: scope.organizationId, userId: scope.userId, role: 'owner' },
  })
  await prisma.projectMember.create({
    data: { projectId: scope.projectId, userId: scope.userId, role: 'owner' },
  })
  await prisma.teamMember.create({
    data: { teamId: scope.teamId, userId: scope.userId, role: 'owner' },
  })
  await prisma.authSession.create({ data: { id: sessionId, userId: scope.userId } })
  await prisma.refreshToken.create({
    data: {
      expiresAt: new Date(Date.now() + 3_600_000),
      familyId: sessionId,
      providerId: 'local',
      providerType: 'local-bootstrap',
      sessionId,
      tokenHash: `designer-evaluation-${sessionId}`,
      userId: scope.userId,
    },
  })
  await prisma.agent.update({
    where: { id: scope.agentId },
    data: {
      name: 'CTO evaluation',
      ownerUserId: scope.userId,
      projectId: scope.projectId,
      teamId: scope.teamId,
    },
  })
  const { AGENT_DESIGNER_BLUEPRINT, ensureGlobalAgentBootstrap } = await import('@nessie/team-admin')
  const designer = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: scope.userId,
  })
  const { ensureBuiltinToolsRegistered } = await import('../../../api/src/services/tools.ts')
  await ensureBuiltinToolsRegistered(prisma, scope.organizationId)
  const browserTool = await prisma.toolRegistryEntry.findFirstOrThrow({
    where: { organizationId: scope.organizationId, toolId: 'browser_open' },
  })
  const conversations = await Promise.all(['Configure CTO', 'Revoke browser access'].map((title) =>
    prisma.thread.create({ data: { agentId: designer.agentId, channelId: designer.channelId, title } }),
  ))
  return { browserTool, conversations, designer, scope, sessionId }
}

export const waitForRun = async (prisma, agentId, threadId) => {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const run = await prisma.run.findFirst({
      where: { agentId, threadId, triggerMessageId: { not: null } },
      orderBy: { createdAt: 'desc' },
    })
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return run
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error(`Designer did not finish conversation ${threadId}`)
}
