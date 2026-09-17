// Running a real agent against the document a real person is looking at.
//
// The browser half of this suite proves people see each other. This is the half
// that proves an *agent* is one of those people: its cursor, its name, its
// colour and the value it is about to write, drawn in somebody's browser before
// the cell changes. That is the entire safety argument for these tools having
// no approval gate, so it is worth driving the real thing rather than injecting
// a frame.
//
// What runs is the real stack, end to end:
//
//   the `spreadsheet-agent-edit` mock-LLM scenario
//     → the worker's own `executeBuiltinTool` (dispatch, access, presence)
//       → `applySpreadsheetBatch` (lock, seq, version, audit)
//         → `PgRealtimeTransport` NOTIFY on the same database
//           → the API replica's document lane
//             → the person's SSE connection
//               → `PresenceOverlay`
//
// The one thing it does not drive is the agentic loop and the model plumbing
// between a scripted turn and a tool call. That has its own coverage against a
// database (`worker/test/db/spreadsheet-agent-run.test.ts`, which runs this
// same scenario through `runAgenticLoop`), and putting a worker, a queue and a
// mock inference endpoint into a browser suite would buy a second proof of it
// at the cost of the one thing only a browser can show.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PrismaClient } from '@prisma/client'
import { loadScenario } from '@nessie/mock-llm'
import { PgRealtimeTransport } from '@nessie/runtime'
import pg from 'pg'

import { REPO_ROOT, databaseUrl } from '../../navigation/lib/config.mjs'

const WORKER_DIST = resolve(REPO_ROOT, 'worker', 'dist', 'run', 'tools.js')

/**
 * The worker is imported from `dist`, so a stale build is a wrong answer that
 * looks like a right one — the tool handlers under test would be the previous
 * commit's. Turbo makes this close to free when it is already current, and the
 * alternative is a suite that silently tests code nobody wrote.
 */
const buildWorker = () => {
  execFileSync(
    'npx',
    ['turbo', 'run', 'build', '--no-daemon', '--filter=@nessie/worker'],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  )
  if (!existsSync(WORKER_DIST)) {
    throw new Error(`the worker did not build: ${WORKER_DIST} is missing`)
  }
}

/**
 * An agent that can edit the suite's space.
 *
 * An explicit `KnowledgeSpaceMember` grant rather than a visibility accident:
 * it is the arm of the access model an agent working in somebody else's space
 * actually travels, and it makes the fixture say out loud that this agent was
 * let in rather than that it happened to reach far enough.
 */
export const seedAgent = async ({ organizationId, projectId, spaceId }) => {
  const prisma = new PrismaClient()
  try {
    const agent = await prisma.agent.create({
      data: {
        name: `Sheets Analyst ${Date.now() % 100_000}`,
        organizationId,
        projectId,
        role: 'analyst',
      },
    })
    await prisma.knowledgeSpaceMember.create({
      data: { agentId: agent.id, organizationId, spaceId },
    })
    // A run row, because the write door keys the automatic "before: <agent>
    // started editing" version off `runId` and the column is a real uuid.
    const channel = await prisma.channel.findFirst({
      where: { organizationId, deletedAt: null },
      select: { id: true, projectId: true, teamId: true },
    })
    if (!channel) throw new Error('the seeded organisation has no channel to run in')
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const run = await prisma.run.create({
      data: { agentId: agent.id, status: 'running', threadId: thread.id },
    })
    return {
      channelId: channel.id,
      id: agent.id,
      name: agent.name,
      projectId: channel.projectId,
      runId: run.id,
      teamId: channel.teamId,
      threadId: thread.id,
    }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * The scripted tool calls, run as the agent.
 *
 * Placeholders rather than ids because a scenario is written before any of
 * these rows exist; `__PAGE__` and `__VERSION__` are filled in here, and
 * `__VERSION__` resolves to the version the write door took before this run's
 * first write — which is the one the scenario then restores.
 */
export const createAgentRunner = async (seed) => {
  buildWorker()
  const { executeBuiltinTool } = await import(pathToFileURL(WORKER_DIST).href)
  const prisma = new PrismaClient()
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 })
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl())

  const contextFor = (agent, toolCallId) => ({
    actorContext: {
      actionContext: { requestId: randomUUID(), teamId: agent.teamId },
      actor: { actorId: agent.id, actorType: 'agent', roles: [] },
      tenant: {
        organizationId: seed.organizationId,
        projectId: agent.projectId,
        teamId: agent.teamId,
      },
    },
    agentId: agent.id,
    agentKind: 'shared',
    channel: {
      id: agent.channelId,
      organizationId: seed.organizationId,
      projectId: agent.projectId,
      systemChannelType: null,
      teamId: agent.teamId,
    },
    ledgerIdentity: null,
    prisma,
    realtimeTransport,
    run: {
      id: agent.runId,
      messageId: randomUUID(),
      // Somebody for the version's indexing job to be attributed to. An agent
      // writing for nobody cannot embed what it wrote.
      originatingUserId: seed.people[0].id,
      principalUserId: seed.people[0].id,
      threadId: agent.threadId,
    },
    toolCallId,
  })

  return {
    close: async () => {
      await prisma.$disconnect()
      await pool.end().catch(() => undefined)
    },
    /**
     * Resolves when the scenario's last tool call has been applied. The caller
     * watches the browser while this runs, so it is deliberately not awaited
     * before the presence assertions — the drafts only exist mid-flight.
     */
    runAgentScenario: async ({ agent, pageId, scenario }) => {
      const script = await loadScenario(scenario)
      const calls = script.turns.flatMap((turn) => turn.toolCalls ?? [])
      const answers = []
      let versionId = null
      for (const call of calls) {
        const args = JSON.parse(
          JSON.stringify(call.arguments)
            .replaceAll('__PAGE__', pageId)
            .replaceAll('__VERSION__', versionId ?? pageId),
        )
        const result = await executeBuiltinTool(
          call.toolName,
          args,
          contextFor(agent, call.toolCallId ?? randomUUID()),
        )
        if (!result.success) {
          throw new Error(`${call.toolName} failed: ${result.output.slice(0, 300)}`)
        }
        const answer = JSON.parse(result.output)
        answers.push({ answer, tool: call.toolName })
        versionId ??= answer.outcome?.versionId ?? null
      }
      return { answers, versionId }
    },
  }
}
