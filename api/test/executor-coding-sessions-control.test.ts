import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'
import {
  canonicalExecutorPayload,
  getExecutorAccessView,
  submitExecutorDescriptor,
} from '@nessie/executor-manage'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorSignedDescriptorSchema,
  parseOrganizationId,
  type AuthorizedActionContext,
  type ExecutorCodingSessionsFacts,
} from '@nessie/schemas'

import { ExecutorAccessViewSchema } from '../src/contracts/executors.js'
import { registerExecutorDaemonRoutes } from '../src/routes/executor-daemon-routes.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * The control plane's coding-sessions surfaces over real rows: the bridge's
 * power facts travel from a signed descriptor through the strict access
 * contract the review screen parses, and the heartbeat route answers with the
 * machine's open close requests through its own response contract.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const keys = generateKeyPairSync('ed25519')
const machinePublicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

const facts: ExecutorCodingSessionsFacts = {
  agents: ['claude', 'codex'], allowedToolCount: 3, configDigest: `sha256:${'c'.repeat(64)}`,
  environmentNames: ['CLAUDE_CONFIG_DIR'], permissionMode: { claude: 'acceptEdits', codex: 'fullAuto' },
  rootNames: ['nessie'], serverName: 'coding-sessions',
}

const signedDescriptor = (revision: number, codingSessions?: ExecutorCodingSessionsFacts) => {
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    ...(codingSessions ? { codingSessions, mcpServers: ['coding-sessions'] } : {}),
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    localPolicyDigest: `sha256:${String(revision).repeat(64).slice(0, 64)}`,
    operationKeys: ['mcp.tools', 'mcp.call'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision,
    sandboxBackend: 'none',
    supervisor: 'desktop',
  })
  return ExecutorSignedDescriptorSchema.parse({
    descriptor,
    signature: sign(
      null, Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)), keys.privateKey,
    ).toString('base64url'),
  })
}

const withExecutor = async (
  run: (world: { actorContext: AuthorizedActionContext; executorId: string; prisma: PrismaClient }) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const executorId = randomUUID()
  try {
    await prisma.organization.create({ data: { id: organizationId, name: `coding sessions ${organizationId}` } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Machine owner' } })
    await prisma.organizationMember.create({ data: { organizationId, role: 'member', userId } })
    await prisma.executor.create({ data: {
      activeConnectionEpoch: 1n, id: executorId, label: 'Workstation', machinePublicKey,
      organizationId, pairingOwnerUserId: userId, profiles: ['workspace_sandbox'], scopeKind: 'private',
      status: 'online', privateAssignments: { create: { principalKind: 'user', role: 'admin', userId } },
    } })
    await run({
      actorContext: {
        actionContext: { requestId: randomUUID() },
        actor: { actorId: userId, actorType: 'user' },
        tenant: { organizationId: parseOrganizationId(organizationId) },
      } as AuthorizedActionContext,
      executorId,
      prisma,
    })
  } finally {
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
}

dbTest('the bridge’s power facts reach the review projection verbatim, and only where the descriptor states them', async () => {
  await withExecutor(async ({ actorContext, executorId, prisma }) => {
    await submitExecutorDescriptor(prisma, { connectionEpoch: '1', descriptor: signedDescriptor(1), executorId })
    await submitExecutorDescriptor(prisma, { connectionEpoch: '1', descriptor: signedDescriptor(2, facts), executorId })
    const access = ExecutorAccessViewSchema.parse(await getExecutorAccessView(prisma, actorContext, executorId))
    const revisions = access.descriptorRevisions ?? []
    assert.deepEqual(revisions.find((revision) => revision.revision === 2)?.codingSessions, facts)
    const without = revisions.find((revision) => revision.revision === 1)
    assert.ok(without)
    assert.equal(Object.hasOwn(without, 'codingSessions'), false, 'absent, not empty')
  })
})

dbTest('the heartbeat route answers with the machine’s open close requests', async () => {
  await withExecutor(async ({ executorId, prisma }) => {
    const ownerKey = `sha256:${'a'.repeat(64)}`
    const sessionId = randomUUID()
    await prisma.executorCodingSessionCloseRequest.createMany({ data: [
      { createdAt: new Date(Date.now() - 2_000), executorId, ownerKey, reason: 'lease_ended' },
      { createdAt: new Date(Date.now() - 1_000), executorId, ownerKey, reason: 'person', sessionId },
    ] })
    const app = Fastify()
    registerExecutorDaemonRoutes(app, { prisma } as unknown as RouteDeps)
    await app.ready()
    try {
      const signed = { connectionEpoch: '1', executorId, observedAt: new Date().toISOString() }
      const signature = sign(
        null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', signed)), keys.privateKey,
      ).toString('base64url')
      const response = await app.inject({
        method: 'POST', payload: { ...signed, signature }, url: '/api/executor-daemon/heartbeat',
      })
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual((response.json() as { data: unknown }).data, {
        codingSessionClose: [
          { ownerKey, reason: 'lease_ended' },
          { ownerKey, reason: 'person', sessionId },
        ],
        connectionEpoch: '1',
        existingSessionsAllowed: true,
        status: 'online',
      })
      await prisma.executor.update({ where: { id: executorId }, data: { scopeKind: 'organization' } })
      const shared = await app.inject({
        method: 'POST', payload: { ...signed, signature }, url: '/api/executor-daemon/heartbeat',
      })
      assert.equal(shared.statusCode, 200, shared.body)
      assert.equal(shared.json().data.existingSessionsAllowed, false)
    } finally {
      await app.close()
    }
  })
})
