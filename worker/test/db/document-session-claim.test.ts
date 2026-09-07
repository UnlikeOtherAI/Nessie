import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  type PgRealtimeTransport,
} from '@nessie/runtime'
import type { KnowledgeProvider } from '@nessie/knowledge'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { createDocumentStreamRecorder } from '../../src/run/execute/document-stream.js'
import { applyDocumentEdits } from '../../src/run/execute/document-stream-edit.js'
import { fileServiceFor } from '../../src/run/file-service.js'
import { runKbDocumentComposeTool } from '../../src/run/pa-tools/knowledge-compose.js'
import { runKbDocumentEditTool } from '../../src/run/pa-tools/knowledge-edit.js'
import { createWorkerKnowledgeProvider } from '../../src/run/pa-tools/knowledge-provider.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

// The document session's own claim (horizontal scaling, row 5.14; audit 2.5).
//
// Everything under test is a decision the DATABASE makes inside one statement:
// whether a session write still matches, given what `runs.executor_token` says
// now. A Prisma fake decides that by whatever its author wrote, which is the
// answer being questioned — so these run against real Postgres.
//
// Scoped to its own seed throughout: this file drives no global poller, but it
// does drive the two knowledge-base save paths, which write attachments and
// pages.

type Fixture = {
  actorContext: RunExecuteJobPayload['actorContext']
  agentId: string
  channelId: string
  organizationId: string
  prisma: PrismaClient
  projectId: string
  realtimeTransport: PgRealtimeTransport
  runId: string
  spaceId: string
  teamId: string
  threadId: string
  userId: string
}

/** A no-op transport: none of these assertions is about what was published. */
const silentTransport = {
  publishSse: async () => undefined as never,
  publishSseEphemeral: async () => undefined as never,
} as unknown as PgRealtimeTransport

const seed = async (prisma: PrismaClient): Promise<Fixture> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Claim author', email: `doc-claim-${suffix}@example.com` },
  })
  const organization = await prisma.organization.create({ data: { name: `doc-claim-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `channel-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `claim-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: agent.id,
      name: `space-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'private',
    },
  })
  await prisma.knowledgeSpaceMember.create({
    data: { organizationId: organization.id, spaceId: space.id, userId: user.id },
  })

  return {
    actorContext: {
      actionContext: {
        effectiveUserId: user.id,
        requestId: `doc-claim-${suffix}`,
        teamId: team.id,
      },
      actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: organization.id, projectId: project.id, teamId: team.id },
    } as unknown as RunExecuteJobPayload['actorContext'],
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    prisma,
    projectId: project.id,
    realtimeTransport: silentTransport,
    runId: run.id,
    spaceId: space.id,
    teamId: team.id,
    threadId: thread.id,
    userId: user.id,
  }
}

const cleanup = async (fixture: Fixture): Promise<void> => {
  const { prisma } = fixture
  const files = fileServiceFor(prisma)
  const attachments = await prisma.attachment.findMany({
    select: { id: true },
    where: { organizationId: fixture.organizationId },
  })
  for (const attachment of attachments) {
    await files
      .delete(
        attachment.id,
        fixture.organizationId,
        attributionFromActorContext(fixture.actorContext),
      )
      .catch(() => undefined)
  }
  await prisma.run.deleteMany({ where: { threadId: fixture.threadId } })
  await prisma.thread.deleteMany({ where: { channelId: fixture.channelId } })
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
  await prisma.user.deleteMany({ where: { id: fixture.userId } })
}

/** Stamp the run with an executor claim, the way `claimRunForExecution` does. */
const holdRun = async (fixture: Fixture, token: string): Promise<void> => {
  await fixture.prisma.$executeRawUnsafe(
    `UPDATE runs SET executor_token = $2::uuid, executor_heartbeat_at = now() WHERE id = $1::uuid`,
    fixture.runId,
    token,
  )
}

const contextFor = (
  fixture: Fixture,
  documentStream: BuiltinToolRuntimeContext['documentStream'],
  toolCallId: string,
): BuiltinToolRuntimeContext => ({
  actorContext: fixture.actorContext,
  agentId: fixture.agentId,
  agentKind: 'shared',
  channel: {
    id: fixture.channelId,
    organizationId: fixture.organizationId,
    systemChannelType: null,
  },
  documentStream,
  ledgerIdentity: null,
  prisma: fixture.prisma,
  realtimeTransport: fixture.realtimeTransport,
  run: {
    id: fixture.runId,
    messageId: randomUUID(),
    originatingUserId: fixture.userId,
    threadId: fixture.threadId,
  },
  toolCallId,
})

/**
 * A client that hands every session write out as a promise.
 *
 * The recorder's own terminaliser is fire-and-forget by design — `beginInvocation`
 * is called from the provider's synchronous chunk callback and cannot await a
 * database round trip — so a test that read the row straight afterwards would be
 * asserting on a race rather than on the fence. Collecting the statements lets
 * the assertion wait for the write to have actually happened.
 */
const trackingClient = (
  prisma: PrismaClient,
  writes: Promise<unknown>[],
): PrismaClient => ({
  knowledgePage: prisma.knowledgePage,
  knowledgeSpace: prisma.knowledgeSpace,
  runDocumentChunk: prisma.runDocumentChunk,
  runDocumentSession: {
    create: prisma.runDocumentSession.create.bind(prisma.runDocumentSession),
    findUnique: prisma.runDocumentSession.findUnique.bind(prisma.runDocumentSession),
    updateMany: (args: Parameters<PrismaClient['runDocumentSession']['updateMany']>[0]) => {
      const write = prisma.runDocumentSession.updateMany(args)
      writes.push(write.catch(() => undefined))
      return write
    },
  },
  $transaction: prisma.$transaction.bind(prisma),
} as unknown as PrismaClient)

/** A real recorder holding `token`, already streaming one compose call. */
const composeRecorder = (
  fixture: Fixture,
  input: {
    markdown: string
    title: string
    token: string | null
    toolCallId: string
    writes?: Promise<unknown>[]
  },
): ReturnType<typeof createDocumentStreamRecorder> => {
  const recorder = createDocumentStreamRecorder({
    claimToken: () => input.token,
    getRestrictionBasis: () => [],
    isRestricted: () => false,
    persistRestrictionBasis: async () => undefined,
    prisma: input.writes
      ? trackingClient(fixture.prisma, input.writes)
      : fixture.prisma,
    realtimeTransport: fixture.realtimeTransport,
    run: {
      agentId: fixture.agentId,
      id: fixture.runId,
      organizationId: fixture.organizationId,
      threadId: fixture.threadId,
    },
  })
  const invocationId = randomUUID()
  recorder.beginInvocation(invocationId)
  recorder.handleToolCallDelta({
    id: input.toolCallId,
    index: 0,
    invocationId,
    text: JSON.stringify({
      markdown: input.markdown,
      spaceId: fixture.spaceId,
      title: input.title,
    }),
    toolName: KB_DOCUMENT_COMPOSE_TOOL_ID,
  })
  return recorder
}

const sessionFor = (fixture: Fixture, toolCallId: string) =>
  fixture.prisma.runDocumentSession.findFirstOrThrow({
    where: { runId: fixture.runId, toolCallId },
  })

/**
 * A knowledge provider that runs `interrupt` in the middle of the save, after
 * the page (or version) exists and before the tool writes the session row. That
 * gap is the whole subject: it is the only moment at which a document can be
 * real and its session record not yet written.
 */
const interruptingProvider = (
  context: BuiltinToolRuntimeContext,
  hook: { at: 'addFileVersion' | 'createPage'; interrupt: () => Promise<void> },
): KnowledgeProvider => {
  const provider = createWorkerKnowledgeProvider(context)
  return {
    ...provider,
    addFileVersion: async (input) => {
      const version = await provider.addFileVersion(input)
      if (hook.at === 'addFileVersion') await hook.interrupt()
      return version
    },
    createPage: async (input) => {
      const page = await provider.createPage(input)
      if (hook.at === 'createPage') await hook.interrupt()
      return page
    },
  }
}

runDatabaseTest(
  'a superseded executor cannot claim a session for saving, and writes no document',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const markdown = '# Superseded\n\nThis document must never be filed.\n'
      const toolCallId = `claim-${randomUUID()}`
      const recorder = composeRecorder(fixture, {
        markdown,
        title: 'Superseded draft',
        token,
        toolCallId,
      })
      await recorder.settle(toolCallId)

      // Another worker takes the run over: `claimRunForExecution` stamps a new
      // token, and from this instant every write this executor makes about the
      // session is a write about a run it no longer holds.
      await holdRun(fixture, randomUUID())

      await assert.rejects(
        runKbDocumentComposeTool(
          contextFor(fixture, recorder, toolCallId),
          { markdown, spaceId: fixture.spaceId, title: 'Superseded draft' },
        ),
        /taken this run over/,
        'the claim for saving must be refused, and say why',
      )

      const session = await sessionFor(fixture, toolCallId)
      assert.equal(session.status, 'streaming', 'the refused claim changed nothing')
      assert.equal(session.pageId, null)
      assert.equal(
        await prisma.knowledgePage.count({ where: { organizationId: fixture.organizationId } }),
        0,
        'refused before the attachment and the page, so no document exists',
      )
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'a superseded executor\'s compose save matches nothing, and its document is kept',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const markdown = '# Filed anyway\n\nThe bytes reached the knowledge base.\n'
      const toolCallId = `save-${randomUUID()}`
      const recorder = composeRecorder(fixture, {
        markdown,
        title: 'Filed anyway',
        token,
        toolCallId,
      })
      await recorder.settle(toolCallId)
      const context = contextFor(fixture, recorder, toolCallId)

      const result = await runKbDocumentComposeTool(
        context,
        { markdown, spaceId: fixture.spaceId, title: 'Filed anyway' },
        {
          provider: interruptingProvider(context, {
            at: 'createPage',
            // The takeover lands after the page exists and before the session
            // write — the one window in which the document is real and the
            // popup's record of it is not.
            interrupt: () => holdRun(fixture, randomUUID()),
          }),
        },
      )

      const session = await sessionFor(fixture, toolCallId)
      assert.equal(session.status, 'saving', 'the superseded save matched no row')
      assert.equal(session.pageId, null)

      // The decision this test pins down: nothing is deleted. The document is a
      // real .md page in its space, reachable by every route that reaches any
      // other document; only the session row is wrong about it.
      const page = await prisma.knowledgePage.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, spaceId: fixture.spaceId },
      })
      assert.ok(page.id)
      assert.equal(
        await prisma.attachment.count({ where: { organizationId: fixture.organizationId } }),
        1,
        'the attachment the page points at is kept too',
      )
      assert.match(result.outputPreview, /document window may still show it as interrupted/)
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'a superseded executor\'s edit save matches nothing, and its version is kept',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const original = '# Notes\n\nOne line.\n'
      const composeToolCallId = `edit-base-${randomUUID()}`
      const baseRecorder = composeRecorder(fixture, {
        markdown: original,
        title: 'Notes',
        token,
        toolCallId: composeToolCallId,
      })
      await baseRecorder.settle(composeToolCallId)
      await runKbDocumentComposeTool(
        contextFor(fixture, baseRecorder, composeToolCallId),
        { markdown: original, spaceId: fixture.spaceId, title: 'Notes' },
      )
      const pageId = (await sessionFor(fixture, composeToolCallId)).pageId
      assert.ok(pageId, 'the base document was saved')

      // A hand-built session row plus a stub recorder, deliberately: the edit
      // tool's own two session writes are what is under test here, and driving
      // the live edit protocol to produce a byte-identical preview would test
      // the scanner instead.
      const edits = [{ find: 'One line.', replace: 'Two lines.\nAnd a second.' }]
      const applied = applyDocumentEdits(original, edits).applied
      const editToolCallId = `edit-${randomUUID()}`
      const session = await prisma.runDocumentSession.create({
        data: {
          agentId: fixture.agentId,
          claimToken: token,
          invocationId: randomUUID(),
          organizationId: fixture.organizationId,
          pageId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          toolCallId: editToolCallId,
        },
      })
      const recorder = {
        beginInvocation: () => undefined,
        close: async () => undefined,
        finalizeOutstanding: async () => undefined,
        handleToolCallDelta: () => undefined,
        hasOpenSession: () => true,
        settle: async () => ({
          claimToken: token,
          markdown: applied,
          parentPageId: null,
          sessionId: session.id,
          spaceId: null,
          title: null,
        }),
      } satisfies BuiltinToolRuntimeContext['documentStream']
      const context = contextFor(fixture, recorder, editToolCallId)

      const result = await runKbDocumentEditTool(
        context,
        { edits, pageId },
        {
          provider: interruptingProvider(context, {
            at: 'addFileVersion',
            interrupt: () => holdRun(fixture, randomUUID()),
          }),
        },
      )

      const after = await prisma.runDocumentSession.findUniqueOrThrow({
        where: { id: session.id },
      })
      assert.equal(after.status, 'saving', 'the superseded save matched no row')
      assert.equal(after.versionNumber, null)
      // Kept, for the same reason as the compose path: the version exists.
      const versions = await prisma.knowledgePageVersion.count({ where: { pageId } })
      assert.equal(versions, 2, 'the new version is kept, not rolled back')
      assert.match(result.outputPreview, /document window may still show it as interrupted/)
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'a superseded executor cannot terminalize a session it no longer holds',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const toolCallId = `terminalize-${randomUUID()}`
      const recorder = composeRecorder(fixture, {
        markdown: '# Half written',
        title: 'Half written',
        token,
        toolCallId,
      })
      await recorder.settle(toolCallId)
      await holdRun(fixture, randomUUID())

      // The failure path's terminaliser, which is also the recorder's own: a
      // fenced-out executor must not report a document lost.
      await recorder.finalizeOutstanding('run_failed')

      const session = await sessionFor(fixture, toolCallId)
      assert.equal(session.status, 'streaming', 'the refused terminaliser changed nothing')
      assert.equal(session.errorReason, null)
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'a superseded executor cannot terminalize a replaced invocation',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const toolCallId = `replaced-${randomUUID()}`
      const writes: Promise<unknown>[] = []
      const recorder = composeRecorder(fixture, {
        markdown: '# Retried',
        title: 'Retried',
        token,
        toolCallId,
        writes,
      })
      await recorder.settle(toolCallId)
      await holdRun(fixture, randomUUID())

      // The recorder's own terminaliser: a new inference attempt marks whatever
      // was streaming `superseded`. Same fence.
      recorder.beginInvocation(randomUUID())
      await recorder.close()
      // The terminaliser is dispatched, not awaited, so wait for the statement
      // it issued rather than for a wall-clock guess.
      await Promise.all(writes)

      const session = await sessionFor(fixture, toolCallId)
      assert.equal(session.status, 'streaming')
      assert.equal(session.errorReason, null)
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'a stalled executor that still holds its run saves over a reaped status',
  async () => {
    const prisma = new PrismaClient()
    const fixture = await seed(prisma)
    try {
      const token = randomUUID()
      await holdRun(fixture, token)
      const markdown = '# Reaped too early\n\nThe document is real.\n'
      const toolCallId = `stalled-${randomUUID()}`
      const recorder = composeRecorder(fixture, {
        markdown,
        title: 'Reaped too early',
        token,
        toolCallId,
      })
      const handle = await recorder.settle(toolCallId)
      assert.ok(handle)
      const context = contextFor(fixture, recorder, toolCallId)

      const result = await runKbDocumentComposeTool(
        context,
        { markdown, spaceId: fixture.spaceId, title: 'Reaped too early' },
        {
          provider: interruptingProvider(context, {
            at: 'createPage',
            // Exactly what the reaper writes when it decides an executor is
            // gone. It is wrong here — this executor still holds the run, it
            // was merely slow — and the document it is writing is complete.
            interrupt: async () => {
              await prisma.runDocumentSession.updateMany({
                data: {
                  errorReason: 'executor_lost',
                  finishedAt: new Date(),
                  status: 'failed',
                },
                where: { id: handle.sessionId },
              })
            },
          }),
        },
      )

      const session = await sessionFor(fixture, toolCallId)
      // The save wins, because the save is the truth: fencing it on the status
      // would preserve a reap that was wrong and discard a filed document.
      assert.equal(session.status, 'saved')
      assert.equal(session.errorReason, 'executor_lost', 'the reap is not rewritten, only outrun')
      assert.ok(session.pageId)
      assert.equal(session.chars, markdown.length)
      assert.doesNotMatch(result.outputPreview, /document window/)
    } finally {
      await cleanup(fixture)
      await prisma.$disconnect()
    }
  },
)
