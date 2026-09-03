import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient, VoiceSession } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import type { AuthorizedActionContext, VoiceTranscriptLine } from '@nessie/schemas'

import { writeVoiceCallRecord } from '../src/services/voice/voice-transcript.js'
import { VoiceSessionError } from '../src/services/voice/voice-session.js'

/**
 * A call cannot be reproduced, so its record and its transcript land together
 * or not at all.
 *
 * These pin the ordering rather than the output. The record used to be
 * committed first and the transcript stored after, which meant a storage
 * failure left a committed record holding the session's set-once claim: the
 * client's retry came back `409 VOICE_TRANSCRIPT_ALREADY_RECORDED`, the
 * transcript was gone permanently, and the surviving record was
 * indistinguishable from a call that never had one — no control on the card, no
 * error, nothing to retry. Two such records were produced by accident on
 * 2026-09-03 while seeding the admin for verification.
 */

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-voice-durability' },
  actor: { actorId: '00000000-0000-4000-8000-000000000001', actorType: 'user' },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
}

const lines: VoiceTranscriptLine[] = [
  { atMs: 500, speaker: 'user', text: 'Can you move the review to Friday?' },
  { atMs: 3_000, speaker: 'assistant', text: 'Moved to Friday at 15:00.' },
]

const session = {
  agentId: '00000000-0000-4000-8000-00000000000a',
  channelId: '00000000-0000-4000-8000-00000000000b',
  endedAt: null,
  id: '00000000-0000-4000-8000-00000000000c',
  organizationId: actorContext.tenant.organizationId,
  startedAt: new Date('2026-09-03T09:00:00.000Z'),
  threadId: '00000000-0000-4000-8000-00000000000d',
  transcriptMessageId: null,
  userId: actorContext.actor.actorId,
} as unknown as VoiceSession

type Trace = {
  claimAttempts: number
  linkedMessageIds: string[]
  messagesCreated: Array<{ metadata: Record<string, unknown> }>
}

/**
 * Only the queries this path makes. A cast fake is unityped, so a query it
 * does not model surfaces as a runtime TypeError rather than a type error —
 * which is exactly what makes it worth keeping this small and extending it in
 * the change that extends the query.
 */
const fakePrisma = (claimCount: number): { prisma: PrismaClient; trace: Trace } => {
  const trace: Trace = { claimAttempts: 0, linkedMessageIds: [], messagesCreated: [] }
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        attachment: {
          update: async ({ data }: { data: { messageId: string } }) => {
            trace.linkedMessageIds.push(data.messageId)
            return { id: 'attachment-1' }
          },
        },
        message: {
          create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
            trace.messagesCreated.push({ metadata: data.metadata })
            return { id: 'message-1' }
          },
        },
        voiceSession: {
          updateMany: async () => {
            trace.claimAttempts += 1
            return { count: claimCount }
          },
        },
      }),
  } as unknown as PrismaClient
  return { prisma, trace }
}

type FileTrace = { deleted: string[]; stored: number }

const fakeFileService = (options: {
  deleteFails?: boolean
  storeFails?: boolean
}): { fileService: FileService; trace: FileTrace } => {
  const trace: FileTrace = { deleted: [], stored: 0 }
  const fileService = {
    delete: async (attachmentId: string) => {
      if (options.deleteFails) throw new Error('storage delete unavailable')
      trace.deleted.push(attachmentId)
      return true
    },
    store: async () => {
      if (options.storeFails) throw new Error('storage unavailable')
      trace.stored += 1
      return { attachment: { id: 'attachment-1' }, bytesWritten: 128 }
    },
  } as unknown as FileService
  return { fileService, trace }
}

const write = async (input: {
  claimCount?: number
  deleteFails?: boolean
  storeFails?: boolean
}) => {
  const { prisma, trace } = fakePrisma(input.claimCount ?? 1)
  const { fileService, trace: fileTrace } = fakeFileService({
    ...(input.deleteFails === undefined ? {} : { deleteFails: input.deleteFails }),
    ...(input.storeFails === undefined ? {} : { storeFails: input.storeFails }),
  })
  const cleanupFailures: unknown[] = []
  const run = writeVoiceCallRecord(prisma, {
    actorContext,
    agentName: 'Ada',
    durationMs: 8_000,
    fileService,
    lines,
    // Absent on purpose: compaction is orthogonal to where the bytes go, and
    // the fallback record exercises the same ordering.
    modelClient: null,
    onTranscriptCleanupFailure: (error) => cleanupFailures.push(error),
    session,
    userDisplayName: 'Ondrej',
  })
  return { cleanupFailures, fileTrace, run, trace }
}

test('a storage failure commits nothing, so the same submission still works', async () => {
  const { fileTrace, run, trace } = await write({ storeFails: true })

  await assert.rejects(run, /storage unavailable/u)

  // The heart of it: no record, and above all no claim. The session's set-once
  // slot is still open, so the client's retry writes the record it was always
  // going to write instead of being refused as already-recorded.
  assert.deepEqual(trace.messagesCreated, [])
  assert.equal(trace.claimAttempts, 0)
  assert.equal(fileTrace.stored, 0)
})

test('the record is created carrying its transcript, not patched afterwards', async () => {
  const { fileTrace, run, trace } = await write({})

  const result = await run
  assert.equal(result.attachmentId, 'attachment-1')
  assert.equal(fileTrace.stored, 1)

  // One metadata write, and it is already complete: a reader of this row never
  // observes a call that has turns but claims no transcript.
  assert.equal(trace.messagesCreated.length, 1)
  const voiceCall = trace.messagesCreated[0]?.metadata['voiceCall'] as Record<string, unknown>
  assert.equal(voiceCall['transcriptAttachmentId'], 'attachment-1')
  assert.equal(voiceCall['turnCount'], 2)

  // Linked to the message inside the claim's own transaction.
  assert.deepEqual(trace.linkedMessageIds, ['message-1'])
})

test('losing the claim race frees the transcript instead of leaking it', async () => {
  const { fileTrace, run } = await write({ claimCount: 0 })

  // Two tabs racing a hang-up still produce exactly one record: the loser is
  // refused here, as before.
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof VoiceSessionError)
    assert.equal(error.code, 'VOICE_TRANSCRIPT_ALREADY_RECORDED')
    return true
  })

  // Storing first means the loser has bytes on disk. They are freed through
  // the one `FileService` chokepoint, which is what writes the balancing usage
  // event — deleting them any other way would leave the storage ledger
  // over-counted.
  assert.deepEqual(fileTrace.deleted, ['attachment-1'])
})

test('a transcript that cannot be freed is reported, and never hides the real error', async () => {
  const { cleanupFailures, run } = await write({ claimCount: 0, deleteFails: true })

  // The caller still learns why the record did not land. Leaked bytes and an
  // over-counted ledger are worth reporting, never worth masking a 409 with.
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof VoiceSessionError)
    assert.equal(error.code, 'VOICE_TRANSCRIPT_ALREADY_RECORDED')
    return true
  })
  assert.equal(cleanupFailures.length, 1)
})

test('a call where nobody spoke stores nothing and still records', async () => {
  const { prisma, trace } = fakePrisma(1)
  const { fileService, trace: fileTrace } = fakeFileService({})

  const result = await writeVoiceCallRecord(prisma, {
    actorContext,
    agentName: 'Ada',
    durationMs: 2_000,
    fileService,
    lines: [],
    modelClient: null,
    session,
    userDisplayName: 'Ondrej',
  })

  assert.equal(result.attachmentId, null)
  assert.equal(fileTrace.stored, 0)
  assert.equal(trace.messagesCreated.length, 1)
  assert.deepEqual(trace.linkedMessageIds, [])
})

/**
 * The fakes above pin the ordering; this pins that it works.
 *
 * Two things only a real database and a real `FileService` can show: that the
 * attachment is linked inside the claim's transaction, and that the loser of a
 * claim race leaves no attachment row behind — the compensating delete has to
 * go through the chokepoint that also writes the balancing usage event.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('the record, its attachment and the storage ledger agree', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const { createFileService, getStorage } = await import('@nessie/runtime')
  const { randomUUID } = await import('node:crypto')
  const { rm } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  // Relative on purpose: `getStorage` joins `localPath` onto `process.cwd()`,
  // so an absolute temp path lands *inside the repository* as `api/var/...`
  // (which is exactly what it did once). Keeping it relative means the path
  // the test removes is the path the test wrote.
  const storageRoot = `.voice-durability-${randomUUID()}`

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: `voice-durability ${organizationId}` },
    })
    await prisma.user.create({
      data: { displayName: 'Ondrej', email: `caller-${userId}@voice.test`, id: userId },
    })
    await prisma.organizationMember.create({ data: { organizationId, role: 'owner', userId } })
    const project = await prisma.project.create({ data: { name: 'P', organizationId } })
    const team = await prisma.team.create({ data: { name: 'T', projectId: project.id } })
    const channel = await prisma.channel.create({
      data: { label: 'Calls', organizationId, projectId: project.id, slug: `calls-${randomUUID()}`, teamId: team.id },
    })
    const thread = await prisma.thread.create({
      data: { channelId: channel.id, title: 'General' },
    })
    const agent = await prisma.agent.create({
      data: { name: 'Ada', organizationId, projectId: project.id, role: 'assistant', teamId: team.id },
    })
    const installation = await prisma.voiceInstallation.create({
      data: { organizationId, platform: 'web', userId },
    })
    const makeSession = () =>
      prisma.voiceSession.create({
        data: {
          agentId: agent.id,
          channelId: channel.id,
          credentialExpiresAt: new Date(Date.now() + 600_000),
          installationId: installation.id,
          ledgerSessionId: randomUUID(),
          maxDurationMs: 1_800_000,
          maxToolCalls: 40,
          model: 'gemini-live',
          organizationId,
          threadId: thread.id,
          userId,
        },
      })

    const fileService = createFileService({
      maxUploadBytes: 5_000_000,
      prisma,
      storage: getStorage({ localPath: storageRoot, provider: 'filesystem' }),
    })
    const call = {
      actorContext: {
        actionContext: { effectiveUserId: userId },
        actor: { actorId: userId, actorType: 'user' as const },
        tenant: { organizationId, projectId: project.id, teamId: team.id },
      } as unknown as AuthorizedActionContext,
      agentName: 'Ada',
      durationMs: 8_000,
      fileService,
      lines,
      modelClient: null,
    }

    const session = await makeSession()
    const record = await writeVoiceCallRecord(prisma, {
      ...call,
      session,
      userDisplayName: 'Ondrej',
    })

    assert.ok(record.attachmentId, 'the transcript must be stored')
    const attachment = await prisma.attachment.findUnique({
      where: { id: record.attachmentId },
    })
    // Linked, not orphaned: the update runs inside the claim's transaction, so
    // a committed record can never point at an unattached transcript.
    assert.equal(attachment?.messageId, record.messageId)
    const message = await prisma.message.findUnique({ where: { id: record.messageId } })
    const voiceCall = (message?.metadata as { voiceCall: Record<string, unknown> }).voiceCall
    assert.equal(voiceCall['transcriptAttachmentId'], record.attachmentId)

    // Now the race: a second submission for a session whose slot is taken.
    const before = await prisma.attachment.count({ where: { organizationId } })
    await assert.rejects(
      writeVoiceCallRecord(prisma, {
        ...call,
        session: await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } }),
        userDisplayName: 'Ondrej',
      }),
      /already has a record/u,
    )
    const after = await prisma.attachment.count({ where: { organizationId } })
    // The loser stored bytes before losing. They are gone again, so a refused
    // submission cannot quietly inflate anybody's storage.
    assert.equal(after, before)

    // The reported bug, against real Postgres: storage refuses, and the
    // question is what survives. Written record-first, a message row was
    // committed here and took the session's set-once slot with it, so the
    // retry was answered 409 and the transcript was unrecoverable. Nothing may
    // be committed now.
    const doomed = await makeSession()
    const messagesBefore = await prisma.message.count({ where: { threadId: thread.id } })
    await assert.rejects(
      writeVoiceCallRecord(prisma, {
        ...call,
        fileService: {
          ...fileService,
          store: async () => {
            throw new Error('storage unavailable')
          },
        } as unknown as typeof fileService,
        session: doomed,
        userDisplayName: 'Ondrej',
      }),
      /storage unavailable/u,
    )
    assert.equal(await prisma.message.count({ where: { threadId: thread.id } }), messagesBefore)
    // And the slot is still open, which is what makes the retry work.
    const retryable = await prisma.voiceSession.findUniqueOrThrow({ where: { id: doomed.id } })
    assert.equal(retryable.transcriptMessageId, null)

    const recovered = await writeVoiceCallRecord(prisma, {
      ...call,
      session: retryable,
      userDisplayName: 'Ondrej',
    })
    assert.ok(recovered.attachmentId, 'the retry records the transcript that was nearly lost')
  } finally {
    await prisma.voiceSession.deleteMany({ where: { organizationId } })
    await prisma.storageUsageEvent.deleteMany({ where: { organizationId } })
    await prisma.attachment.deleteMany({ where: { organizationId } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
    await prisma.$disconnect()
    await rm(join(process.cwd(), storageRoot), { force: true, recursive: true })
  }
})
