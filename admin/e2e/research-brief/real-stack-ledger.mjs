// The DeepWater side of the real-stack research walk (`real-stack.mjs`):
// the team's switch and connector, and Ledger's answers.
//
// Ledger cannot be doubled on the wire here, by design. The worker reaches it
// only through `safeFetch`, which refuses a loopback address
// (docs/standards/egress.md), and every call needs a UOA signer that this
// local stack does not have. So Ledger's answers are played the way the
// worker's own watch applies them: the answer is parsed with
// `LedgerScopeResultSchema`, applied with `applyDeepWaterScopeResult` under
// `runDeepWaterTransaction`, and announced through the same Postgres realtime
// transport — so the browser hears `integration.run.updated` and the research
// card's `message.new` from the real API exactly as it would after a watch
// read. A research's card is posted by the worker's own
// `ensureDeepWaterResearchCard`.
//
// Nothing here can reach Ledger or UOA: the connector points at an `.invalid`
// host (RFC 2606), and the runner starts the API with no Ledger key and no UOA
// signer, so the embedded worker's own watch fails closed before any call.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { applyDeepWaterScopeResult, insertDeepWaterBriefRun, PgRealtimeTransport } from '@nessie/runtime'
import { LedgerScopeResultSchema } from '@nessie/schemas'
import pg from 'pg'

import { REPO_ROOT, databaseUrl } from '../navigation/lib/config.mjs'

// The worker's and connector manager's built code, imported by path: the admin
// does not depend on either package, and these are the functions the worker
// itself runs.
const fromRepo = (path) => import(pathToFileURL(resolve(REPO_ROOT, path)).href)
const { deepWaterBriefTools } = await fromRepo('packages/mcp-manage/dist/index.js')
const { runDeepWaterTransaction } = await fromRepo('worker/dist/control/deepwater-announce.js')
const { ensureDeepWaterResearchCard } = await fromRepo('worker/dist/control/deepwater-messages.js')

/** Where the seeded connector says Ledger is: a name that never resolves. */
export const UNREACHABLE_LEDGER_URL = 'https://ledger.e2e.invalid/v1/mcp/deepwater'

const SETTINGS = {
  depth: 'standard', chapter_depth: 'standard', search_quality: 'standard', languages: [],
  output_language: 'en', recency: 'any', writing_style: 'standard',
}

const researchId = () => `rs_${randomUUID().replaceAll('-', '')}`

/**
 * One brief as Water holds it: its transcript, pillars and one open question,
 * in the wire shape `research_scope_get` returns with its transcript.
 */
const scopeResult = ({ id, launched = false, question, reply, revision, topic, turn }) =>
  LedgerScopeResultSchema.parse({
    id,
    status: launched ? 'running' : 'drafting',
    error_code: null,
    title: null,
    turn: { id: turn, seq: 1, status: 'complete', author_kind: 'person', error_code: null, retryable: false },
    brief: {
      state: launched ? 'launched' : 'drafting',
      revision,
      topic,
      reply,
      pillars: ['Running costs against gas', 'Grants for landlords'],
      settings: SETTINGS,
      locked_settings: [],
      open_questions: question
        ? [{ question, why: 'Grants differ by nation.', suggested_answers: ['England', 'Scotland'] }]
        : [],
      analysis: null,
      ready: true,
      messages: [
        {
          id: randomUUID(), seq: '1', turn_id: turn, role: 'requester', author_kind: 'person', event: null,
          content: topic, brief_revision: 0, created_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          id: randomUUID(), seq: '2', turn_id: turn, role: 'planner', author_kind: null, event: null,
          content: reply, brief_revision: revision, created_at: new Date().toISOString(),
        },
      ],
    },
  })

export const openDeepWaterSeed = () => {
  const url = databaseUrl()
  const prisma = new PrismaClient({ datasources: { db: { url } } })
  const pool = new pg.Pool({ connectionString: url, max: 2 })
  const deps = { prisma, realtime: new PgRealtimeTransport(pool, url) }

  /** Apply one Ledger answer as the watch does, announcing what a viewer would see. */
  const applyAnswer = (organizationId, runId, result) =>
    runDeepWaterTransaction(deps, async (tx, announce) => {
      const outcome = await applyDeepWaterScopeResult(tx, { organizationId, runId, result })
      if (!outcome.applied) throw new Error(`Ledger's answer was not applied to ${runId}: ${outcome.reason}`)
      if (outcome.changed) announce.run(outcome.run)
      const card = outcome.launched
        ? await ensureDeepWaterResearchCard(tx, announce, { organizationId, runId })
        : null
      return { cardMessageId: card?.messageId ?? null, run: outcome.run }
    })

  /** Turn DeepWater on for the team with a connector on the brief contract. */
  const enableTeam = async ({ organizationId, teamId, userId }) => {
    const catalog = await prisma.mcpCatalogEntry.findFirstOrThrow({
      where: { name: 'deep-water', organizationId: null, visibility: 'public' },
      select: { id: true },
    })
    const connector = await prisma.mcpServerInstance.create({
      data: {
        catalogEntryId: catalog.id,
        credentialRef: 'LEDGER_PROXY_TOKEN',
        installedBy: userId,
        lifecycleState: 'active',
        organizationId,
        scopeId: teamId,
        scopeType: 'team',
        transportConfig: { transport: 'http', url: UNREACHABLE_LEDGER_URL },
        discoveredTools: deepWaterBriefTools.map((tool) => ({ name: tool.name })),
      },
    })
    await prisma.productTeamEnablement.upsert({
      where: { organizationId_teamId_productSlug: { organizationId, teamId, productSlug: 'deep-water' } },
      create: { organizationId, teamId, productSlug: 'deep-water', enabled: true },
      update: { enabled: true },
    })
    return connector.id
  }

  /**
   * A person's brief, written by the insert the brief API uses, then opened by
   * Ledger: its first planner turn answered, with one question for the person.
   */
  const openBrief = async ({ channelId, connectorId, organizationId, teamId, threadId, topic, userId }) => {
    const inserted = await prisma.$transaction((tx) => insertDeepWaterBriefRun(tx, {
      organizationId,
      teamId,
      requestedByUserId: userId,
      connectorId,
      channelId,
      threadId,
      identity: { subject: `uoa|${userId}`, organizationId: 'uoa-e2e-org', teamId: 'uoa-e2e-team', tokenVersion: 1 },
      input: { schemaVersion: 1, topic, context: null, pillars: null, settings: null, originRootMessageId: null },
      // The origin room is public, so the brief starts with no sources (N6).
      sourceScopes: [],
      disclosureSources: [],
      origin: { kind: 'person', actionId: randomUUID() },
    }))
    const brief = { id: researchId(), topic, turn: randomUUID() }
    await applyAnswer(organizationId, inserted.run.id, scopeResult({
      ...brief,
      question: 'Which part of the UK is this for?',
      reply: 'I can research this. Which part of the UK should it cover?',
      revision: 1,
    }))
    return { runId: inserted.run.id, ...brief }
  }

  /**
   * Ledger shows the brief launched: the run starts and its card is posted to
   * the room. Answers the card's message id.
   */
  const launchBrief = async (organizationId, brief) => (await applyAnswer(organizationId, brief.runId, scopeResult({
    ...brief,
    launched: true,
    question: null,
    reply: 'Starting the research now.',
    revision: 2,
  }))).cardMessageId

  /** Everything the walk wrote, removed in dependency order. */
  const cleanup = async ({ connectorId, organizationId, runIds, teamId }) => {
    const runs = await prisma.productIntegrationRun.findMany({
      where: { id: { in: runIds } },
      select: { messageId: true },
    })
    await prisma.$executeRawUnsafe(
      `DELETE FROM queue_jobs WHERE topic LIKE 'deep_water.%' AND payload->>'organizationId' = $1`,
      organizationId,
    )
    await prisma.productIntegrationRun.deleteMany({ where: { id: { in: runIds } } })
    const cards = runs.map((run) => run.messageId).filter(Boolean)
    await prisma.message.deleteMany({ where: { OR: [{ id: { in: cards } }, { rootMessageId: { in: cards } }] } })
    if (connectorId) await prisma.mcpServerInstance.deleteMany({ where: { id: connectorId } })
    await prisma.productTeamEnablement.deleteMany({ where: { organizationId, teamId, productSlug: 'deep-water' } })
  }

  const close = async () => {
    await prisma.$disconnect()
    await pool.end()
  }

  return { cleanup, close, enableTeam, launchBrief, openBrief, prisma }
}
