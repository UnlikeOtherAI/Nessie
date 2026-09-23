import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { PrismaClient, type ExecutorCommandReceiptState } from '@prisma/client'
import { rateLimitKeyHash } from '@nessie/db'
import { createFileService, getStorage, type FileService } from '@nessie/runtime'
import { canonicalExecutorPayload } from '@nessie/schemas'

import { EXECUTOR_ATTACHMENT_RATE_BUCKET } from '../src/executor-command-attachments.js'
import { encryptExecutorCommandJson } from '../src/executor-command-codec.js'

/**
 * One launched local-apps run with a paired, online executor, and a way to
 * make `mcp.call` commands under it in any receipt state and to sign the
 * daemon's image uploads for them. The rows are written directly — the
 * binding flows have their own suites — so each case can name the exact state
 * it needs. Every id is fresh, so suites sharing the database never meet.
 *
 * The channel is private: the launching person and one colleague are in it,
 * an outsider is only in the organisation.
 */

export const ATTACHMENT_SECRET = 'executor-command-attachment-test-secret'

/** The real screenshot Kelpie answered with on Windows: example.com, 13 715 bytes. */
export const kelpieScreenshot = (): Buffer => {
  const result = JSON.parse(readFileSync(
    new URL('../../../executor/test/fixtures/kelpie-screenshot-result.json', import.meta.url),
    'utf8',
  )) as { content: Array<{ data?: string; type: string }> }
  const image = result.content.find((item) => item.type === 'image')
  if (!image?.data) throw new Error('The Kelpie fixture lost its image.')
  return Buffer.from(image.data, 'base64')
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Bytes a PNG's magic starts, of an exact size; distinct on every call. */
export const pngBytes = (size: number): Buffer =>
  Buffer.concat([PNG_SIGNATURE, randomBytes(size - PNG_SIGNATURE.length)])

export const digestOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** Prisma's default pool is far wider than one suite needs beside its neighbours. */
export const attachmentTestPrisma = (): PrismaClient => {
  const url = new URL(process.env.DATABASE_URL as string)
  url.searchParams.set('connection_limit', '6')
  return new PrismaClient({ datasources: { db: { url: url.toString() } } })
}

export type AttachmentWorld = Awaited<ReturnType<typeof seedAttachmentWorld>>

export const seedAttachmentWorld = async (
  prisma: PrismaClient,
  options: { channelVisibility?: 'private' | 'public' } = {},
) => {
  const organizationId = randomUUID()
  const [holderId, colleagueId, outsiderId] = [randomUUID(), randomUUID(), randomUUID()]
  const agentId = randomUUID()
  const executorId = randomUUID()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const machinePublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  await prisma.organization.create({ data: { id: organizationId, name: `attachments ${organizationId}` } })
  await prisma.user.createMany({
    data: [holderId, colleagueId, outsiderId].map((id) => ({
      id, email: `${id}@example.test`, displayName: id.slice(0, 8),
    })),
  })
  await prisma.organizationMember.createMany({
    data: [holderId, colleagueId, outsiderId].map((userId) => ({ organizationId, role: 'member', userId })),
  })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
      visibility: options.channelVisibility ?? 'private',
      members: { create: [{ userId: holderId }, { userId: colleagueId }] },
    },
  })
  await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const run = await prisma.run.create({ data: { agentId, status: 'running', threadId: thread.id } })
  await prisma.executor.create({
    data: {
      id: executorId, organizationId, pairingOwnerUserId: holderId, label: 'Workstation', scopeKind: 'private',
      status: 'online', lastSeenAt: new Date(), activeConnectionEpoch: 1n, machinePublicKey,
      profiles: ['workspace_sandbox'],
    },
  })
  const revision = await prisma.executorCapabilityRevision.create({
    data: {
      executorId, revision: 1, signature: 'reviewed-test-descriptor', localPolicyDigest: `sha256:${'3'.repeat(64)}`,
      reviewStatus: 'active', reviewedByUserId: holderId,
      descriptor: { operationKeys: ['mcp.tools', 'mcp.call'], revision: 1 },
    },
  })
  const handleDigest = `sha256:${randomBytes(32).toString('hex')}`
  await prisma.executorAvailabilityCandidate.create({
    data: {
      actorUserId: holderId, agentId, authorizationRevision: 1, capabilityRevisionId: revision.id,
      consumedAt: new Date(), executorId, expiresAt: new Date(Date.now() + 3_600_000), handleDigest,
      operationKeys: ['mcp.tools', 'mcp.call'], runId: run.id,
    },
  })
  const binding = await prisma.executorBinding.create({
    data: {
      authorizationRevision: 1, candidateHandleDigest: handleDigest, capabilityRevisionId: revision.id,
      executorId, fence: 1n, operationKey: 'mcp.call', runId: run.id,
    },
  })

  // One binding per operation, as the launch makes them.
  const bindings = new Map<string, string>([['mcp.call', binding.id]])
  const bindingFor = async (operationKey: string): Promise<string> => {
    const known = bindings.get(operationKey)
    if (known) return known
    const created = await prisma.executorBinding.create({
      data: {
        authorizationRevision: 1, candidateHandleDigest: handleDigest, capabilityRevisionId: revision.id,
        executorId, fence: 1n, operationKey, runId: run.id,
      },
    })
    bindings.set(operationKey, created.id)
    return created.id
  }

  /** An `mcp.call` to Kelpie under the launch, in `state` — or a command of `operationKey`. */
  const createCommand = async (
    state: ExecutorCommandReceiptState = 'started',
    server = 'kelpie',
    operationKey = 'mcp.call',
  ) => {
    const bindingId = await bindingFor(operationKey)
    const toolCall = await prisma.toolCall.create({
      data: {
        agentId, executorBindingId: bindingId, inputSummary: `server=${server}`, runId: run.id,
        startedAt: new Date(), toolName: 'executor_mcp_call',
      },
    })
    const queueJob = await prisma.queueJob.create({
      data: { idempotencyKey: `attachment-test:${executorId}:${toolCall.id}`, payload: {}, status: 'processing', topic: 'executor.command' },
    })
    const payload = { args: { server, tool: 'screenshot' }, runId: run.id }
    const command = await prisma.executorCommand.create({
      data: {
        argumentDigest: `sha256:${'4'.repeat(64)}`, bindingId, queueJobId: queueJob.id, state,
        deliveryPayloadCiphertext: encryptExecutorCommandJson(ATTACHMENT_SECRET, payload),
        payloadExpiresAt: new Date(Date.now() + 60_000), toolCallId: toolCall.id,
      },
    })
    return command.id
  }

  /** The daemon's signed upload of `bytes` for `commandId`, with any field overridden. */
  const upload = (
    commandId: string,
    bytes: Buffer,
    override: {
      byteLength?: number
      digest?: string
      domain?: string
      executorId?: string
      mimeType?: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
    } = {},
  ) => {
    const attachment = {
      byteLength: override.byteLength ?? bytes.length,
      commandId,
      digest: override.digest ?? digestOf(bytes),
      mimeType: override.mimeType ?? 'image/png',
      occurredAt: new Date().toISOString(),
    }
    const signed = { attachment, connectionEpoch: '1', executorId: override.executorId ?? executorId }
    return {
      ...signed,
      dataBase64: bytes.toString('base64'),
      signature: sign(
        null,
        Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${override.domain ?? 'attachment'}.v1`, signed)),
        privateKey,
      ).toString('base64url'),
    }
  }

  /** A signed poll, for proving the executor lock is free. */
  const signedPoll = () => {
    const payload = { connectionEpoch: '1', executorId, observedAt: new Date().toISOString() }
    return {
      ...payload,
      payload,
      signature: sign(
        null,
        Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.poll.v1', payload)),
        privateKey,
      ).toString('base64url'),
      type: 'poll' as const,
    }
  }

  const storagePath = path.join(tmpdir(), `nessie-command-attachments-${randomUUID()}`)
  const fileService: FileService = createFileService({
    prisma,
    storage: getStorage({ provider: 'filesystem', localPath: storagePath }),
    maxUploadBytes: 64 * 1024 * 1024,
  })

  const cleanup = async () => {
    await prisma.storageUsageEvent.deleteMany({ where: { organizationId } })
    await prisma.attachment.deleteMany({ where: { organizationId } })
    await prisma.budget.deleteMany({ where: { organizationId } })
    await prisma.$executeRaw`
      DELETE FROM "rate_limit_buckets" WHERE "key_hash" = ${rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, executorId)}
    `
    const bindingIds = [...bindings.values()]
    const commands = await prisma.executorCommand.findMany({
      where: { bindingId: { in: bindingIds } }, select: { queueJobId: true },
    })
    await prisma.executorCommand.deleteMany({ where: { bindingId: { in: bindingIds } } })
    await prisma.queueJob.deleteMany({ where: { id: { in: commands.map((command) => command.queueJobId) } } })
    await prisma.toolCall.deleteMany({ where: { runId: run.id } })
    await prisma.executorBinding.deleteMany({ where: { executorId } })
    await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.thread.deleteMany({ where: { channelId: channel.id } })
    await prisma.channel.deleteMany({ where: { id: channel.id } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [holderId, colleagueId, outsiderId] } } })
    await rm(storagePath, { force: true, recursive: true })
  }

  return {
    agentId, bindingId: binding.id, channelId: channel.id, cleanup, colleagueId, createCommand, executorId,
    fileService, holderId, organizationId, outsiderId, prisma, runId: run.id, signedPoll, threadId: thread.id, upload,
    /** The machine key as the daemon keeps it (PKCS#8 DER, base64url), for its own signing code. */
    machinePrivateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  }
}
