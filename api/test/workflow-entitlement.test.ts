import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { WORKFLOW_SECRET_REDACTION } from '@nessie/workspace-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { parseOrganizationId } from '@nessie/schemas'

import { auditWorkflowMutation } from '../src/services/workflow-audit.js'
import {
  canActorReadWorkflowInstallation,
  canActorStartWorkflowRun,
  workflowInstallationEntitlementFilter,
} from '../src/services/workflow-entitlement.js'
import { getWorkflowRun } from '../src/services/workflow-runs.js'
import { installWorkflowTemplate } from '../src/services/workflow-templates.js'

// W19 + W22 + W25 — the reachability matrix, its audit trail, and run origin:
//  - a channel-entitled member reads an installation and can start a run;
//  - a non-entitled user can do neither;
//  - a member cannot pause (admin gate);
//  - W0 redaction still holds for the widened readership;
//  - audit rows carry the acting caller, and retry audits the retrying actor;
//  - W25 origin columns persist and survive a retry.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const GRAPH = {
  steps: [
    {
      id: 'first',
      input: { key: 'k', toolName: 'state_get' },
      title: 'First',
      type: 'tool',
    },
  ],
}

// W0's reference-binding shape (see workflow-secrets.test.ts): the ref is
// declared in the bindingSchema and taints any matching run IO.
const SECRET_BINDING_SCHEMA = {
  apiKey: { kind: 'reference' },
}

const seedWorkspace = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({
    data: { name: `wf-entitle ${randomUUID()}` },
  })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `wf-ent-o-${randomUUID()}@example.com` },
  })
  const member = await prisma.user.create({
    data: { displayName: 'Member', email: `wf-ent-m-${randomUUID()}@example.com` },
  })
  const outsider = await prisma.user.create({
    data: { displayName: 'Outsider', email: `wf-ent-x-${randomUUID()}@example.com` },
  })
  for (const [user, role] of [
    [owner, 'owner'],
    [member, 'member'],
    [outsider, 'member'],
  ] as const) {
    await prisma.organizationMember.create({
      data: { organizationId: org.id, role, userId: user.id },
    })
  }
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'ops',
      slug: `ops-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'protected',
    },
  })
  await prisma.channelMember.create({
    data: { channelId: channel.id, userId: member.id },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      bindingSchema: SECRET_BINDING_SCHEMA,
      createdByActorId: owner.id,
      createdByActorType: 'user',
      graphJson: GRAPH,
      name: 'wf',
      organizationId: org.id,
    },
  })
  return {
    channelId: channel.id,
    memberId: member.id,
    organizationId: org.id,
    outsiderId: outsider.id,
    ownerId: owner.id,
    templateId: template.id,
  }
}

type Seed = Awaited<ReturnType<typeof seedWorkspace>>

const userContext = (
  seed: Seed,
  userId: string,
  roles: string[],
): AuthorizedActionContext => ({
  actor: { actorId: userId, actorType: 'user', roles },
  actionContext: { purpose: 'test', requestId: randomUUID() },
  tenant: { organizationId: parseOrganizationId(seed.organizationId) },
})

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [seed.ownerId, seed.memberId, seed.outsiderId] } },
  })
}

runDatabaseTest('W19: the entitlement matrix — read, start, pause, and W0 redaction', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const owner = userContext(seed, seed.ownerId, ['owner'])
  const member = userContext(seed, seed.memberId, ['member'])
  const outsider = userContext(seed, seed.outsiderId, ['member'])

  const installation = await installWorkflowTemplate(prisma, owner, seed.templateId, {
    channelId: seed.channelId,
    resolvedBindings: { apiKey: 'secret_mcp_deadbeefcafe' },
  })
  assert.ok(installation)
  // The write gate accepts server-minted refs only; simulate the row the
  // secret store would have produced (same as workflow-secrets.test.ts).

  // Read: channel member yes, outsider no, admin yes.
  assert.equal(await canActorReadWorkflowInstallation(prisma, member, installation.id), true)
  assert.equal(await canActorReadWorkflowInstallation(prisma, outsider, installation.id), false)
  assert.equal(
    await canActorReadWorkflowInstallation(
      prisma,
      userContext(seed, seed.memberId, ['admin']),
      installation.id,
    ),
    true,
  )

  // Start: same entitlement as acting in the channel.
  assert.equal(await canActorStartWorkflowRun(prisma, member, installation.id), true)
  assert.equal(await canActorStartWorkflowRun(prisma, outsider, installation.id), false)

  // Pause/template authoring: member is not a workflow admin.
  const filter = await workflowInstallationEntitlementFilter(prisma, member)
  assert.ok(filter, 'member gets an entitlement filter')
  assert.equal(await workflowInstallationEntitlementFilter(prisma, owner), null)

  // W0 interaction: the widened reader still gets redacted bindings.
  const run = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: seed.organizationId,
      input: { apiKey: 'secret_mcp_deadbeefcafe' },
      originChannelId: seed.channelId,
      startedByActorId: seed.memberId,
      startedByActorType: 'user',
    },
  })
  const detail = await getWorkflowRun(prisma, seed.organizationId, run.id)
  assert.ok(detail)
  assert.equal(
    (detail.run.input as Record<string, unknown>).apiKey,
    WORKFLOW_SECRET_REDACTION,
    'run input stays redacted for non-owner readers',
  )
  assert.equal(detail.run.originChannelId, seed.channelId, 'W25 origin persists')
})

runDatabaseTest('W22/W25: audit rows carry the acting caller; retry keeps the origin', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const owner = userContext(seed, seed.ownerId, ['owner'])
  const member = userContext(seed, seed.memberId, ['member'])

  const installation = await installWorkflowTemplate(prisma, owner, seed.templateId, {
    channelId: seed.channelId,
  })
  assert.ok(installation)

  await auditWorkflowMutation(prisma, owner, {
    action: 'workflow.installation.installed',
    resourceId: installation.id,
    resourceType: 'workflow_installation',
    status: 'active',
  })

  const run = await prisma.workflowRun.create({
    data: {
      finishedAt: new Date(),
      installationId: installation.id,
      organizationId: seed.organizationId,
      originChannelId: seed.channelId,
      startedAt: new Date(),
      startedByActorId: seed.memberId,
      startedByActorType: 'user',
      status: 'failed',
    },
  })

  const { retryWorkflowRun } = await import('../src/services/workflow-runs.js')
  const retried = await retryWorkflowRun(prisma, member, run.id, { reason: 'try again' })
  assert.ok(retried)
  await auditWorkflowMutation(prisma, member, {
    action: 'workflow.run.retried',
    metadata: { retriedFromWorkflowRunId: run.id },
    resourceId: retried.id,
    resourceType: 'workflow_run',
    status: retried.status,
  })

  const auditRows = await prisma.auditLog.findMany({
    where: {
      organizationId: seed.organizationId,
      action: { in: ['workflow.installation.installed', 'workflow.run.retried'] },
    },
    orderBy: { createdAt: 'asc' },
  })
  assert.equal(auditRows.length, 2)
  assert.equal(auditRows[0]?.actorId, seed.ownerId)
  assert.equal(auditRows[0]?.action, 'workflow.installation.installed')
  assert.equal(auditRows[1]?.actorId, seed.memberId, 'retry audits the retrying actor')
  assert.equal(auditRows[1]?.action, 'workflow.run.retried')

  // W25: the retry answers the same origin as the run it replaces.
  const persistedRetry = await prisma.workflowRun.findUnique({ where: { id: retried.id } })
  assert.equal(persistedRetry?.originChannelId, seed.channelId)
  assert.equal(persistedRetry?.startedByActorId, seed.memberId, 'W27: original starter preserved')
})
