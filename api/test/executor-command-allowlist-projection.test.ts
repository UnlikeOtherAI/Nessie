import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  canonicalExecutorPayload,
  getExecutorAccessView,
  submitExecutorDescriptor,
} from '@nessie/executor-manage'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorSignedDescriptorSchema,
  parseOrganizationId,
  parseTeamId,
  type AuthorizedActionContext,
  type ExecutorCapabilityDescriptor,
} from '@nessie/schemas'

import { ExecutorAccessViewSchema } from '../src/contracts/executors.js'

/**
 * The permitted-program list travels on the signed capability descriptor. This
 * walks it the whole way a person's decision depends on: a daemon submits a
 * signed descriptor, the control plane stores that revision, and the review
 * surface reads it back out through the real `/api/executors/:id/access`
 * response contract.
 *
 * The route itself needs a whole server to register, so the assertion runs the
 * service the route calls and then the exact schema the route parses with.
 * That schema is `.strict()`, so a projection the contract does not carry
 * fails here rather than at a reviewer's browser.
 *
 * Two revisions, because absent and named are different facts: revision 1
 * names no program and permits none, revision 2 names three. A projection that
 * rendered them alike would be the bug this exists to catch.
 */

const suite = 'c7d2'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const teamId = `00000000-0000-4000-8000-${suite}00000002`
const projectId = `00000000-0000-4000-8000-${suite}00000003`
const ownerUserId = `00000000-0000-4000-8000-${suite}00000010`
const executorId = `00000000-0000-4000-8000-${suite}00000020`

const PROGRAMS = ['git', 'node', 'rg'] as const

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: ownerUserId, roles: ['owner'] },
  tenant: { organizationId: parseOrganizationId(orgId), teamId: parseTeamId(teamId) },
  actionContext: { requestId: `req-executor-allowlist-${suite}`, teamId: parseTeamId(teamId) },
}

const keys = generateKeyPairSync('ed25519')
const machinePublicKey = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64url')

const signedDescriptor = (
  revision: number,
  commandAllowlist?: readonly string[],
) => {
  const descriptor: ExecutorCapabilityDescriptor = ExecutorCapabilityDescriptorSchema.parse({
    ...(commandAllowlist ? { commandAllowlist: [...commandAllowlist] } : {}),
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1_024, maxSessions: 1 },
    localPolicyDigest: `sha256:${String(revision).repeat(64).slice(0, 64)}`,
    operationKeys: ['command.run', 'workspace.review', 'sandbox.stop'],
    platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision,
    sandboxBackend: 'virtualization_framework',
    supervisor: 'desktop',
  })
  return ExecutorSignedDescriptorSchema.parse({
    descriptor,
    signature: sign(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)),
      keys.privateKey,
    ).toString('base64url'),
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.executorCapabilityRevision.deleteMany({ where: { executorId } })
  await prisma.executor.deleteMany({ where: { id: executorId } })
  await prisma.organizationMember.deleteMany({ where: { userId: ownerUserId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.user.deleteMany({ where: { id: ownerUserId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `executor-allowlist-${suite}` } })
  await prisma.user.create({
    data: {
      displayName: 'Executor allowlist owner',
      email: `executor-allowlist-${suite}@test.local`,
      id: ownerUserId,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId: orgId, role: 'owner', userId: ownerUserId },
  })
  await prisma.project.create({
    data: { id: projectId, name: `anchor-${suite}`, organizationId: orgId },
  })
  await prisma.team.create({ data: { id: teamId, name: `team-${suite}`, projectId } })
  await prisma.executor.create({
    data: {
      activeConnectionEpoch: 1n,
      id: executorId,
      label: `allowlist-${suite}`,
      machineKeyFingerprint: `sha256:${'a'.repeat(64)}`,
      machinePublicKey,
      organizationId: orgId,
      pairingOwnerUserId: ownerUserId,
      profiles: ['workspace_sandbox'],
      scopeKind: 'organization',
      status: 'online',
    },
  })
}

const withDatabase = async (run: (prisma: PrismaClient) => Promise<void>) => {
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

dbTest('a submitted permitted-program list reaches the descriptor-review projection', async () => {
  await withDatabase(async (prisma) => {
    await submitExecutorDescriptor(prisma, {
      connectionEpoch: '1',
      descriptor: signedDescriptor(1),
      executorId,
    })
    await submitExecutorDescriptor(prisma, {
      connectionEpoch: '1',
      descriptor: signedDescriptor(2, PROGRAMS),
      executorId,
    })

    const access = await getExecutorAccessView(prisma, actorContext, executorId)
    assert.ok(access, 'the organization owner manages an organization-scoped executor')
    // The response the admin actually parses, not a hand-built shape.
    const parsed = ExecutorAccessViewSchema.parse(access)
    const revisions = parsed.descriptorRevisions ?? []
    assert.equal(revisions.length, 2)

    const named = revisions.find((revision) => revision.revision === 2)
    assert.ok(named)
    assert.deepEqual(named.commandAllowlist, [...PROGRAMS])

    // Absent, not empty: a projection that answered `[]` here would claim the
    // daemon named a list, and the two states would read the same downstream.
    const unnamed = revisions.find((revision) => revision.revision === 1)
    assert.ok(unnamed)
    assert.equal(unnamed.commandAllowlist, undefined)
    assert.equal(Object.hasOwn(unnamed, 'commandAllowlist'), false)
  })
})

dbTest('an executor a person cannot manage is told no policy at all', async () => {
  await withDatabase(async (prisma) => {
    await submitExecutorDescriptor(prisma, {
      connectionEpoch: '1',
      descriptor: signedDescriptor(1, PROGRAMS),
      executorId,
    })
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: ownerUserId } },
      data: { role: 'member' },
    })

    const access = await getExecutorAccessView(prisma, actorContext, executorId)
    assert.ok(access)
    assert.equal(access.canManage, false)
    assert.equal(ExecutorAccessViewSchema.parse(access).descriptorRevisions, undefined)
  })
})
