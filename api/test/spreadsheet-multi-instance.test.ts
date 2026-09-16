import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'
import { PrismaClient } from '@prisma/client'
import { PgRealtimeTransport, type RealtimeNotificationPayload } from '@nessie/runtime'
import {
  applySpreadsheetBatch,
  bootstrapSpreadsheet,
  createSpreadsheetModelCache,
  createSpreadsheetPage,
  createSpreadsheetService,
  loadWorkbook,
  publishSpreadsheetPresence,
  readSpreadsheetRange,
  requestSpreadsheetPresence,
  type SpreadsheetModelCache,
  type SpreadsheetWorkbook,
} from '@nessie/knowledge'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import type { FileService } from '@nessie/runtime'
import type { SpreadsheetBatchSummary } from '@nessie/schemas'

import { createDocumentLane, type DocumentSseConnection } from '../src/realtime/document-lane.js'

/**
 * The multi-instance smoke case: two API replicas, one database, one page.
 *
 * Everything the live lane promises is a *cross-process* promise, and nothing
 * in-process can check it. Both halves of this file are therefore real: a real
 * `PgRealtimeTransport` per instance with its own pool and its own LISTEN
 * session, a real document lane per instance, and a real spreadsheet service
 * per instance with **its own model cache**. A shared fake would pass while
 * production dropped every event.
 *
 * Three things are proved, and each is a separate way the design can be wrong:
 *
 * 1. **Ops cross.** A batch applied on instance A arrives on a document stream
 *    held by instance B. If the write door published in-process only, a person
 *    whose SSE landed on another replica would watch a frozen grid.
 * 2. **Presence re-announces across instances.** A pane opening on B asks, and
 *    a pane on A answers, and the answer reaches B. Presence is stateless by
 *    design (`realtime-and-presence.md`), so this round trip is the *only*
 *    thing that puts a peer on another replica into the overlay.
 * 3. **The cache is not an authority.** B's model cache holds the page at the
 *    seq it last saw. A writes. B's next read still answers with A's value,
 *    because every read fast-forwards from the journal under the page lock.
 *
 * The two transports share one NOTIFY channel, unique per run, so the case is
 * honest on a database other suites are using at the same time.
 */

const databaseUrl = process.env['DATABASE_URL']
const dbTest = databaseUrl ? test : test.skip

type Instance = {
  label: string
  transport: PgRealtimeTransport
  cache: SpreadsheetModelCache
  service: ReturnType<typeof createSpreadsheetService>
  lane: ReturnType<typeof createDocumentLane>
  /** Raw SSE frames written to this instance's one open pane. */
  written: string[]
  connection: DocumentSseConnection
  close: () => Promise<void>
}

/** The multi-instance case never snapshots, so nothing here stores bytes. */
const inertFileService = {
  store: async () => {
    throw new Error('the multi-instance case must not write a file')
  },
  openStream: async () => null,
  openDownload: async () => null,
  delete: async () => true,
  purgeKnowledgePageFiles: async () => undefined,
  purgeEmailMessageFiles: async () => undefined,
  checkQuota: async () => ({ allowed: true }),
  currentUsage: async () => ({ usedBytes: 0n, limitBytes: null }),
  usageForScope: async () => 0n,
  setThumbnail: async () => undefined,
} as unknown as FileService

const startInstance = async (input: {
  label: string
  channel: string
  prisma: PrismaClient
  pageId: string
  organizationId: string
  userId: string
}): Promise<Instance> => {
  const pool = new Pool({ connectionString: databaseUrl as string, max: 2 })
  const transport = new PgRealtimeTransport(pool, databaseUrl as string, input.channel)
  const cache = createSpreadsheetModelCache()
  const provider = createNativeKnowledgeProvider(input.prisma)
  const service = createSpreadsheetService({
    prisma: input.prisma,
    fileService: inertFileService,
    cache,
    createPage: (created) => provider.createPage(created),
    addFileVersion: (version) => provider.addFileVersion(version),
    publish: async (event, published) => {
      await transport.publishDocumentEphemeral(
        published.pageId,
        published.organizationId,
        event,
        published.data,
      )
    },
  })
  const lane = createDocumentLane({ canAccessKnowledgePage: async () => true })

  const written: string[] = []
  const connection = {
    kind: 'document',
    pageId: input.pageId,
    spaceId: 'space',
    organizationId: input.organizationId,
    userId: input.userId,
    clientId: `${input.label}-pane`,
    saturated: false,
    response: {
      once: () => undefined,
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
    },
  } as unknown as DocumentSseConnection
  lane.documentConnections.add(connection)

  await transport.listen(async (payload: RealtimeNotificationPayload) => {
    if (payload.kind !== 'document') return
    await lane.deliverDocumentNotification(payload)
  })

  return {
    label: input.label,
    transport,
    cache,
    service,
    lane,
    written,
    connection,
    close: async () => {
      await transport.close()
      await pool.end()
    },
  }
}

/** SSE frames are `event: <name>\ndata: <json>\n\n`. */
const framesOf = (written: string[]): { event: string; data: Record<string, unknown> }[] =>
  written.map((chunk) => {
    const [head, body] = chunk.split('\ndata: ')
    return {
      event: (head ?? '').replace('event: ', ''),
      data: JSON.parse((body ?? '{}').trim()) as Record<string, unknown>,
    }
  })

/**
 * NOTIFY is delivered on another connection's own schedule, so the case waits
 * for the frame rather than for a fixed sleep — a sleep would be either flaky
 * or slow, and this fails with the frames it did see.
 */
const waitForFrame = async (
  written: string[],
  event: string,
  timeoutMs = 5_000,
): Promise<{ event: string; data: Record<string, unknown> }> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = framesOf(written).find((candidate) => candidate.event === event)
    if (frame) return frame
    if (Date.now() > deadline) {
      throw new Error(
        `no '${event}' frame within ${timeoutMs}ms; saw ${JSON.stringify(framesOf(written).map((f) => f.event))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const cellSummary = (): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [0],
  cellCount: 1,
  touched: [],
})

/** The browser's flush, exactly: pause, edit, resume, evaluate, flush. */
const diffsFor = (client: SpreadsheetWorkbook, edit: () => void): Buffer => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue())
}

dbTest('two replicas share one page: ops cross, presence re-announces, the cache is not an authority', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const channel = `nessie_realtime_mi_${randomUUID().replace(/-/g, '')}`.slice(0, 60)
  let instanceA: Instance | null = null
  let instanceB: Instance | null = null

  try {
    await prisma.organization.create({ data: { id: organizationId, name: `multi-${organizationId}` } })
    await prisma.user.create({
      data: { id: userId, email: `${userId}@multi.test`, displayName: 'Multi tester' },
    })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
    const project = await prisma.project.create({ data: { organizationId, name: 'multi project' } })
    const team = await prisma.team.create({ data: { projectId: project.id, name: 'multi team' } })
    const space = await prisma.knowledgeSpace.create({
      data: {
        organizationId,
        projectId: project.id,
        teamId: team.id,
        name: 'multi space',
        visibility: 'project',
        createdBy: userId,
      },
    })

    // The page is created through one instance's service; the other has never
    // heard of it, which is the state a second replica is actually in.
    const bootstrapper = createSpreadsheetService({
      prisma,
      fileService: inertFileService,
      cache: createSpreadsheetModelCache(),
      createPage: (created) => createNativeKnowledgeProvider(prisma).createPage(created),
      addFileVersion: (version) => createNativeKnowledgeProvider(prisma).addFileVersion(version),
    })
    const page = await createSpreadsheetPage(bootstrapper, {
      organizationId,
      spaceId: space.id,
      projectId: project.id,
      title: 'Shared across replicas',
      authorId: userId,
      authorType: 'user',
      createdBy: userId,
    })

    instanceA = await startInstance({ label: 'a', channel, prisma, pageId: page.id, organizationId, userId })
    instanceB = await startInstance({ label: 'b', channel, prisma, pageId: page.id, organizationId, userId })

    const actor = { type: 'user' as const, id: userId, displayName: 'Multi tester' }
    const attribution = {
      organizationId,
      actorType: 'user',
      actorId: userId,
    } as unknown as Parameters<typeof applySpreadsheetBatch>[1]['attribution']

    // ── 3, first half: warm B's cache *before* A writes ──────────────────
    // A cache that was populated after the write would prove nothing; this is
    // the stale entry the fast-forward has to get past. A bootstrap on its own
    // would not do it — it hands the client the hot snapshot and the journal
    // tail without ever building a server model — so B's pane is simulated
    // properly: bootstrap for the bytes, then a read, which is what puts a
    // model in the cache.
    const bootstrapped = await bootstrapSpreadsheet(instanceB.service, {
      organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor },
    })
    await readSpreadsheetRange(instanceB.service, {
      organizationId,
      pageId: page.id,
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 1, c1: 1 },
    })
    assert.equal(instanceB.cache.get(page.id)?.seq, 0, "B's cache must hold the page at seq 0")

    // ── 1: a batch applied on A is delivered on B's stream ───────────────
    const client = loadWorkbook(Buffer.from(bootstrapped.snapshot.bytes, 'base64'))
    const applied = await applySpreadsheetBatch(
      instanceA.service,
      {
        organizationId,
        pageId: page.id,
        clientOpId: randomUUID(),
        actor,
        attribution,
        source: {
          kind: 'client',
          diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'from instance A')),
          baseSeq: 0,
        },
      },
      cellSummary(),
    )
    assert.equal(applied.batch?.seq, 1)

    const ops = await waitForFrame(instanceB.written, 'sheet.ops')
    assert.equal(ops.data['seq'], 1)
    assert.equal(ops.data['pageId'], page.id)
    // A's own pane sees it too — the publisher does not special-case itself,
    // and the client drops its own `clientOpId`.
    assert.equal((await waitForFrame(instanceA.written, 'sheet.ops')).data['seq'], 1)

    // ── 2: presence request on B, answer on A, answer lands on B ─────────
    await requestSpreadsheetPresence(instanceB.service, { organizationId, pageId: page.id })
    const request = await waitForFrame(instanceA.written, 'sheet.presence.request')
    assert.equal(request.data['pageId'], page.id)

    await publishSpreadsheetPresence(instanceA.service, {
      organizationId,
      pageId: page.id,
      actor,
      canWrite: true,
      frame: {
        clientId: 'a-pane',
        sheet: 0,
        selection: { r0: 1, c0: 1, r1: 1, c1: 1 },
        cursor: { r: 1, c: 1 },
        draft: null,
        ts: new Date().toISOString(),
      },
    })
    const announced = await waitForFrame(instanceB.written, 'sheet.presence')
    assert.equal(announced.data['clientId'], 'a-pane')
    assert.equal((announced.data['actor'] as { id?: string }).id, userId)
    // Stamped by the server from the head, so B can label the peer's sheet
    // without a lookup of its own.
    assert.equal(announced.data['sheetName'], 'Sheet1')

    // ── 3, second half: B reads A's value through its stale cache ────────
    const read = await readSpreadsheetRange(instanceB.service, {
      organizationId,
      pageId: page.id,
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 1, c1: 1 },
    })
    assert.equal(read.rows[0]?.[0]?.value, 'from instance A')
    assert.equal(
      instanceB.cache.get(page.id)?.seq,
      1,
      "B's cache must have been fast-forwarded to A's seq, not replaced wholesale",
    )
  } finally {
    await instanceA?.close()
    await instanceB?.close()
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  }
})
