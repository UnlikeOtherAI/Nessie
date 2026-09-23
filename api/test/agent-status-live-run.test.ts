import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { WsScope } from '@nessie/schemas'

import { loadAgentStatus } from '../src/services/agent-read-model.js'
import { buildSnapshotForScopes } from '../src/services/agent-read-snapshot.js'

/**
 * The agent header offers Stop from the status read's `currentRunId`, so the
 * read has to name a run in every state a cancel accepts — the two
 * suspensions included, where a person most wants to stop it. A suspended run
 * is waiting on a person rather than using a tool, so it names no tool.
 */

const agentId = '00000000-0000-4000-8000-0000000000d1'
const runId = '00000000-0000-4000-8000-0000000000d2'
const now = new Date('2026-09-23T10:00:00.000Z')

type RunStatus = 'pending' | 'running' | 'waiting_approval' | 'waiting_input' | 'completed'

// The stub answers the query the way Postgres would: only runs whose status
// the query asked for come back.
const agentWithRun = (status: RunStatus) => {
  const run = {
    createdAt: now,
    id: runId,
    status,
    // The gated tool call a suspension leaves open.
    toolCalls: [{ endedAt: null, startedAt: now, toolName: 'executor_mcp_call' }],
  }
  const agentRow = (statuses: readonly string[]) => ({
    agentKind: 'shared',
    childAgents: [],
    id: agentId,
    messages: [],
    organizationId: '00000000-0000-4000-8000-0000000000d3',
    runs: statuses.includes(status) ? [run] : [],
    status: 'idle',
    systemManaged: false,
    updatedAt: now,
  })
  type RunsQuery = { include: { runs: { where: { status: { in: string[] } } } } }
  return {
    agent: {
      findFirst: async ({ include }: RunsQuery) => agentRow(include.runs.where.status.in),
      findMany: async ({ include }: RunsQuery) => [agentRow(include.runs.where.status.in)],
    },
    runBasisScope: { findMany: async () => [] },
  } as unknown as PrismaClient
}

const scopes: WsScope[] = [{ agentId, kind: 'agent' }]

for (const status of ['waiting_approval', 'waiting_input'] as const) {
  test(`a ${status} run is the agent's current run, with no active tool`, async () => {
    const prisma = agentWithRun(status)
    const read = await loadAgentStatus(prisma, agentId)
    assert.equal(read?.currentRunId, runId)
    assert.equal(read?.currentToolName, undefined)
    assert.equal(read?.currentToolStartedAt, undefined)

    // A reconnect's snapshot says the same as the read and the live event.
    const snapshot = await buildSnapshotForScopes(prisma, scopes)
    assert.equal(snapshot.agents[0]?.currentRunId, runId)
    assert.equal(snapshot.agents[0]?.currentToolName, undefined)
  })
}

test('a running run still names its open tool', async () => {
  const read = await loadAgentStatus(agentWithRun('running'), agentId)
  assert.equal(read?.currentRunId, runId)
  assert.equal(read?.currentToolName, 'executor_mcp_call')
})

test('a finished run is nobody’s current run', async () => {
  const prisma = agentWithRun('completed')
  assert.equal((await loadAgentStatus(prisma, agentId))?.currentRunId, undefined)
  assert.equal((await buildSnapshotForScopes(prisma, scopes)).agents[0]?.currentRunId, undefined)
})
