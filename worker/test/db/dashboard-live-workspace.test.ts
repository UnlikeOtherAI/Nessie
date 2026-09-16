import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { CredentialStore } from '@nessie/dashboard'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'

import { createDashboardToolServices } from '../../src/run/pa-tools/dashboard-context.js'
import { runDashboardTool } from '../../src/run/pa-tools/dashboards.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { deleteThreadQueueJobs, runDatabaseTest } from './support.js'

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  runId: string
  teamId: string
  threadId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `dashboard-live-${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Dashboard user', email: `dashboard-live-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({ data: { name: 'Dashboards', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Dashboards', projectId: project.id } })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id } })
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'dashboard conversation',
      members: { create: { userId: user.id } },
      organizationId: organization.id,
      projectId: project.id,
      slug: `dashboard-live-${suffix}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'dashboard request' } })
  const agent = await prisma.agent.create({
    data: { agentKind: 'shared', name: 'Dashboard Designer', organizationId: organization.id, role: 'assistant' },
  })
  const run = await prisma.run.create({ data: { agentId: agent.id, status: 'running', threadId: thread.id } })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    projectId: project.id,
    runId: run.id,
    teamId: team.id,
    threadId: thread.id,
    userId: user.id,
  }
}

const contextFor = (prisma: PrismaClient, seed: Seed): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  // The test models a source the agent received from this same conversation.
  // Its basis is the project, because that is the dashboard's audience now: a
  // source verified only for one channel may no longer feed a dashboard every
  // member of the project can open, and the service refuses it.
  consumedSources.add({ scopeId: seed.projectId, scopeType: 'project' })
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: seed.agentId,
      model: null,
      name: 'Dashboard Designer',
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      id: seed.channelId,
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      systemChannelType: null,
      teamId: seed.teamId,
    },
    consumedSources,
    run: { createdAt: new Date(), id: seed.runId, replyPlacement: null, threadId: seed.threadId },
    task: { id: randomUUID() },
  }
  return {
    actorContext: {
      actionContext: { requestId: randomUUID() },
      actor: { actorId: seed.userId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: seed.organizationId, projectId: seed.projectId, teamId: seed.teamId },
    } as BuiltinToolRuntimeContext['actorContext'],
    agentId: seed.agentId,
    agentKind: 'shared',
    channel: { id: seed.channelId, organizationId: seed.organizationId, systemChannelType: null },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => undefined } as PgRealtimeTransport,
    run: { id: seed.runId, interactive: true, messageId: randomUUID(), threadId: seed.threadId },
    runContext,
    toolCallId: randomUUID(),
  }
}

/**
 * Tool handlers use the production dashboard services and real Postgres writes.
 * Bytes are in-memory only so this test stays independent of a deployment's
 * object store; the services still receive two distinct retained attachments.
 */
const files = (): FileService => ({
  checkQuota: async () => ({ allowed: true, limitBytes: null, usedBytes: 0n }),
  currentUsage: async () => ({ limitBytes: null, usedBytes: 0n }),
  delete: async () => true,
  openStream: async () => null,
  purgeEmailMessageFiles: async () => undefined,
  purgeKnowledgePageFiles: async () => undefined,
  setThumbnail: async () => null,
  store: async () => ({ attachment: { id: randomUUID() }, bytesWritten: 0 }) as never,
  usageForScope: async () => 0n,
}) as FileService

const credentials: CredentialStore = {
  delete: async () => undefined,
  put: async () => 'secret_dashboard_test',
  resolve: async () => null,
}

runDatabaseTest('dashboard tools create, present, and edit one live conversation dashboard', async (t) => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  t.after(async () => {
    await deleteThreadQueueJobs(prisma, fixture.threadId)
    await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
    await prisma.user.deleteMany({ where: { id: fixture.userId } })
    await prisma.$disconnect()
  })
  const context = contextFor(prisma, fixture)
  const services = createDashboardToolServices({
    credentials,
    fileService: files(),
    loadDataset: () => async () => null,
    prisma,
  })

  // A dashboard lives in a project; the tool used to take a `home` and the
  // scope column that went with it.
  const created = await runDashboardTool('dashboard_create', context, {
    projectId: fixture.projectId,
    title: 'Quarterly revenue',
  }, services)
  assert.match(created.outputPreview, /Created dashboard/)
  const dashboard = await prisma.dashboard.findFirstOrThrow({ where: { organizationId: fixture.organizationId } })

  const imported = await runDashboardTool('dashboard_source_import', context, {
    content: 'quarter,revenue\nQ1,12\nQ2,28\n',
    format: 'csv',
    name: 'Quarterly upload',
    provenance: { submittedBy: 'conversation' },
    sourceReference: 'User-uploaded quarterly CSV',
  }, services)
  assert.match(imported.outputPreview, /Imported CSV/)
  const source = await prisma.dashboardDataSource.findFirstOrThrow({
    where: { organizationId: fixture.organizationId, kind: 'static' },
  })

  const addWidgetArgs = {
    dashboardId: dashboard.id,
    definition: {
      binding: { columns: [{ key: 'quarter', label: 'Quarter' }, { key: 'revenue', label: 'Revenue' }] },
      kind: 'table',
      presentation: { title: 'Quarterly revenue' },
      schemaVersion: 1,
      sourceId: source.id,
    },
  }
  context.toolCallId = randomUUID()
  await runDashboardTool('dashboard_widget_add', context, addWidgetArgs, services)
  await runDashboardTool('dashboard_widget_add', context, addWidgetArgs, services)
  assert.equal(
    await prisma.dashboardWidget.count({ where: { dashboardId: dashboard.id } }),
    1,
    'retrying one add-widget tool call must replay instead of duplicating',
  )
  const presented = await runDashboardTool('dashboard_present', context, { dashboardId: dashboard.id }, services)
  assert.match(presented.outputPreview, /Presented/)

  const cardMessage = await prisma.message.findFirstOrThrow({
    orderBy: { createdAt: 'desc' },
    where: { agentId: fixture.agentId, threadId: fixture.threadId },
  })
  assert.deepEqual(cardMessage.metadata, {
    dashboardPresentation: { dashboardId: dashboard.id, schemaVersion: 1 },
  })

  context.toolCallId = randomUUID()
  const updated = await runDashboardTool('dashboard_presentation_update', context, {
    dashboardId: dashboard.id,
    presentation: {
      attributions: [{ label: 'Quarterly upload', sourceId: source.id, visible: true }],
      filters: [{
        column: 'quarter',
        id: randomUUID(),
        label: 'Q2 only',
        sourceId: source.id,
        values: ['Q2'],
      }],
      insights: [{ id: randomUUID(), text: 'Q2 leads the period.', tone: 'success' }],
      style: 'executive',
    },
  }, services)
  assert.match(updated.outputPreview, /Updated dashboard/)

  const [delta, version, material] = await Promise.all([
    prisma.dashboardDelta.findFirstOrThrow({
      orderBy: { revision: 'desc' },
      where: { dashboardId: dashboard.id },
    }),
    prisma.dashboardVersion.findFirstOrThrow({
      orderBy: { versionNumber: 'desc' },
      where: { dashboardId: dashboard.id },
    }),
    prisma.dashboardSourceMaterial.findFirstOrThrow({ where: { sourceId: source.id } }),
  ])
  assert.equal(delta.runId, fixture.runId)
  assert.equal(version.runId, fixture.runId)
  assert.equal(material.sourceReference, 'User-uploaded quarterly CSV')
  // The basis is what the run actually consumed, and `contextFor` now seeds
  // the project — a dashboard's audience is its project, so a source verified
  // only for one channel could not feed one.
  assert.deepEqual(material.accessBasis, [{ scopeId: fixture.projectId, scopeType: 'project' }])
})

/**
 * The near miss the project arm must still refuse.
 *
 * Presenting accepts a source whose verified audience is the *room's own*
 * project, because a dashboard's audience is its project and such a source is
 * therefore no wider than the dashboard carrying it. A source proved for some
 * other project is wider, and must not ride into this room on that rule.
 */
runDatabaseTest('a source verified for another project is still refused', async (t) => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  t.after(async () => {
    await deleteThreadQueueJobs(prisma, fixture.threadId)
    await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
    await prisma.user.deleteMany({ where: { id: fixture.userId } })
    await prisma.$disconnect()
  })
  const services = createDashboardToolServices({
    credentials,
    fileService: files(),
    loadDataset: () => async () => null,
    prisma,
  })

  // A second project in the same organisation: somewhere the acting person is
  // a member, so only the basis — not membership — decides this.
  const elsewhere = await prisma.project.create({
    data: { name: 'Elsewhere', organizationId: fixture.organizationId },
  })
  await prisma.projectMember.create({ data: { projectId: elsewhere.id, userId: fixture.userId } })

  const context = contextFor(prisma, fixture)
  const created = await runDashboardTool('dashboard_create', context, {
    projectId: fixture.projectId,
    title: 'Quarterly revenue',
  }, services)
  assert.match(created.outputPreview, /Created dashboard/)
  const dashboard = await prisma.dashboard.findFirstOrThrow({
    where: { organizationId: fixture.organizationId },
  })

  await runDashboardTool('dashboard_source_import', context, {
    content: 'quarter,revenue\nQ1,12\n',
    format: 'csv',
    name: 'Quarterly upload',
    provenance: { submittedBy: 'conversation' },
    sourceReference: 'User-uploaded quarterly CSV',
  }, services)
  const source = await prisma.dashboardDataSource.findFirstOrThrow({
    where: { organizationId: fixture.organizationId, kind: 'static' },
  })
  context.toolCallId = randomUUID()
  await runDashboardTool('dashboard_widget_add', context, {
    dashboardId: dashboard.id,
    definition: {
      binding: { columns: [{ key: 'quarter', label: 'Quarter' }] },
      kind: 'table',
      presentation: { title: 'Quarterly revenue' },
      schemaVersion: 1,
      sourceId: source.id,
    },
  }, services)

  // Re-stamp the material's basis as the other project. Everything else about
  // the dashboard is unchanged, so only the scope under test can decide.
  await prisma.dashboardSourceMaterial.updateMany({
    data: { accessBasis: [{ scopeId: elsewhere.id, scopeType: 'project' }] },
    where: { sourceId: source.id },
  })

  context.toolCallId = randomUUID()
  const presented = await runDashboardTool(
    'dashboard_present', context, { dashboardId: dashboard.id }, services,
  )
  assert.doesNotMatch(presented.outputPreview, /Presented/)
  assert.match(presented.outputPreview, /not entitled to every source/)
})
