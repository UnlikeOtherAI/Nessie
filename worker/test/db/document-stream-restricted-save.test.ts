import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  type PgRealtimeTransport,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { createDocumentStreamRecorder } from '../../src/run/execute/document-stream.js'
import { fileServiceFor } from '../../src/run/file-service.js'
import { runKbDocumentComposeTool } from '../../src/run/pa-tools/knowledge-compose.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest(
  'a restricted stream still saves byte-identically and refuses a scanner/parser mismatch',
  async (t) => {
    const prisma = new PrismaClient()
    const suffix = randomUUID()
    const user = await prisma.user.create({
      data: { displayName: 'Document author', email: `document-stream-${suffix}@example.com` },
    })
    const organization = await prisma.organization.create({
      data: { name: `document-stream-${suffix}` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, role: 'member', userId: user.id },
    })
    const project = await prisma.project.create({
      data: { name: `project-${suffix}`, organizationId: organization.id },
    })
    const team = await prisma.team.create({
      data: { name: `team-${suffix}`, projectId: project.id },
    })
    const channel = await prisma.channel.create({
      data: {
        label: `channel-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        slug: `doc-${suffix.slice(0, 8)}`,
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
        name: `private-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
        visibility: 'private',
      },
    })
    await prisma.knowledgeSpaceMember.create({
      data: {
        organizationId: organization.id,
        spaceId: space.id,
        userId: user.id,
      },
    })

    const actorContext = {
      actionContext: {
        effectiveUserId: user.id,
        requestId: `document-stream-${suffix}`,
        teamId: team.id,
      },
      actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
      tenant: {
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
      },
    } as unknown as RunExecuteJobPayload['actorContext']

    t.after(async () => {
      const files = fileServiceFor(prisma)
      const attachments = await prisma.attachment.findMany({
        where: { organizationId: organization.id },
        select: { id: true },
      })
      for (const attachment of attachments) {
        await files.delete(
          attachment.id,
          organization.id,
          attributionFromActorContext(actorContext),
        ).catch(() => undefined)
      }
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: user.id } })
      await prisma.$disconnect()
    })

    const published: Array<{ data: unknown; event: string }> = []
    const realtimeTransport = {
      publishSse: async (_threadId: string, event: string, data: unknown) => {
        published.push({ data, event })
        return undefined as never
      },
      publishSseEphemeral: async (_threadId: string, event: string, data: unknown) => {
        published.push({ data, event })
        return undefined as never
      },
    } as unknown as PgRealtimeTransport

    const makeRecorder = (invocationId: string, toolCallId: string, markdown: string) => {
      const recorder = createDocumentStreamRecorder({
        getRestrictionBasis: () => [{ scopeId: user.id, scopeType: 'user' }],
        isRestricted: () => true,
        persistRestrictionBasis: async (basis) => {
          await prisma.runBasisScope.createMany({
            data: basis.map((scope) => ({
              organizationId: organization.id,
              runId: run.id,
              scopeId: scope.scopeId,
              scopeType: scope.scopeType,
            })),
            skipDuplicates: true,
          })
        },
        prisma,
        realtimeTransport,
        run: {
          agentId: agent.id,
          id: run.id,
          organizationId: organization.id,
          threadId: thread.id,
        },
      })
      recorder.beginInvocation(invocationId)
      recorder.handleToolCallDelta({
        id: toolCallId,
        index: 0,
        invocationId,
        text: JSON.stringify({ markdown, spaceId: space.id, title: 'Restricted draft' }),
        toolName: KB_DOCUMENT_COMPOSE_TOOL_ID,
      })
      return recorder
    }

    const contextFor = (
      documentStream: ReturnType<typeof makeRecorder>,
      toolCallId: string,
    ): BuiltinToolRuntimeContext => ({
      actorContext,
      agentId: agent.id,
      agentKind: 'shared',
      channel: {
        id: channel.id,
        organizationId: organization.id,
        systemChannelType: null,
      },
      documentStream,
      ledgerIdentity: null,
      prisma,
      realtimeTransport,
      run: {
        id: run.id,
        messageId: randomUUID(),
        originatingUserId: user.id,
        threadId: thread.id,
      },
      toolCallId,
    })

    const markdown = '# Privileged brief\n\nExact bytes: café 🚢\n'
    const matchingToolCallId = 'restricted-save-match'
    const recorder = makeRecorder('invocation-match', matchingToolCallId, markdown)
    const result = await runKbDocumentComposeTool(
      contextFor(recorder, matchingToolCallId),
      { markdown, spaceId: space.id, title: 'Restricted draft' },
    )

    assert.equal(result.toolName, KB_DOCUMENT_COMPOSE_TOOL_ID)
    const saved = await prisma.runDocumentSession.findFirstOrThrow({
      where: { runId: run.id, toolCallId: matchingToolCallId },
      include: { chunks: { orderBy: { id: 'asc' } } },
    })
    assert.equal(saved.status, 'saved')
    assert.equal(saved.chars, markdown.length)
    assert.equal(saved.chunks.map((chunk) => chunk.content).join(''), markdown)
    assert.ok(saved.pageId)
    assert.ok(saved.attachmentId)
    assert.deepEqual(
      published.map((event) => event.event),
      ['stream.document.start'],
      'a restricted successful save must not publish document text or metadata',
    )
    assert.equal((published[0]?.data as { restricted?: boolean }).restricted, true)

    const mismatchedToolCallId = 'restricted-save-mismatch'
    const mismatchRecorder = makeRecorder(
      'invocation-mismatch',
      mismatchedToolCallId,
      'streamed bytes',
    )
    await assert.rejects(
      runKbDocumentComposeTool(
        contextFor(mismatchRecorder, mismatchedToolCallId),
        { markdown: 'parsed bytes', spaceId: space.id, title: 'Restricted draft' },
      ),
      /streamed document did not match the final arguments/,
    )
    const mismatch = await prisma.runDocumentSession.findFirstOrThrow({
      where: { runId: run.id, toolCallId: mismatchedToolCallId },
    })
    assert.equal(mismatch.status, 'failed')
    assert.equal(mismatch.errorReason, 'save_failed')
  },
)
