// What a thread SSE client is actually promised when it reconnects with a
// `Last-Event-ID` after losing the replica that served it.
//
// The multi-instance chaos smoke asserts "SSE resume replays with no sequence
// gap", and for a long time that was read as "every `thread_stream_events` row
// after the watermark comes back". It never can: `hub.ts` deliberately refuses
// to replay five event types — `stream.start`, `stream.reasoning`,
// `stream.thinking.tool`, `stream.delta` and `stream.document.delta` — because
// they are a live preview of state that is durable elsewhere, and replaying
// them paints a zombie pending bubble on a run that already finished.
//
// So the promise has two halves, and this pins both:
//   1. every DURABLE, replayable row above the watermark is re-delivered, in id
//      order, each carrying its own `id:` line, and nothing at or below the
//      watermark is re-sent;
//   2. the live-only rows are skipped rather than dropped from the bookkeeping —
//      the watermark still advances past them, so the next live event is
//      delivered once and the client's Last-Event-ID keeps pointing at the real
//      head of the log.
//
// Postgres-backed: `createRealtimeHub` opens a real pool and a real LISTEN
// client, publishes through the transport's locked one-transaction path, and
// the replay reads `thread_stream_events` for real.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { PrismaClient } from '@prisma/client'
import { parseAgentId, parseRunId, parseThreadId } from '@nessie/schemas'

import { createRealtimeHub } from '../src/realtime/hub.js'

const databaseUrl = process.env.DATABASE_URL
const dbTest = databaseUrl ? test : test.skip

type Recorder = {
  frames: () => string
  ids: () => number[]
  sink: ServerResponse
}

// The hub only ever calls `write` and `once('drain')` on a connection, so a
// recorder is enough — and unlike a socket it keeps every frame for assertion.
const createRecorder = (): Recorder => {
  const chunks: string[] = []
  const sink = {
    once: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: () => undefined,
    writableEnded: false,
  }
  const frames = () => chunks.join('')
  return {
    frames,
    ids: () =>
      frames()
        .split('\n')
        .filter((line) => line.startsWith('id:'))
        .map((line) => Number(line.slice(3).trim())),
    sink: sink as unknown as ServerResponse,
  }
}

type Seed = { agentId: string; organizationId: string; runId: string; threadId: string }

// A thread needs its whole tenancy chain: `thread_stream_events` carries an FK
// to `threads`, and the replay query reads the row back by thread id.
const seedThread = async (
  query: (text: string, values: unknown[]) => Promise<unknown>,
): Promise<Seed> => {
  const seed: Seed = {
    agentId: randomUUID(),
    organizationId: randomUUID(),
    runId: randomUUID(),
    threadId: randomUUID(),
  }
  const channelId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  await query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'SSE resume replay', now(), now())`,
    [seed.organizationId],
  )
  await query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
     VALUES ($1, 'SSE resume replay', $2, now(), now())`,
    [projectId, seed.organizationId],
  )
  await query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at)
     VALUES ($1, 'SSE resume replay', $2, now(), now())`,
    [teamId, projectId],
  )
  await query(
    `INSERT INTO channels (id, label, slug, organization_id, project_id, team_id, created_at, updated_at)
     VALUES ($1, 'SSE resume replay', $2, $3, $4, $5, now(), now())`,
    [channelId, `sse-resume-${channelId}`, seed.organizationId, projectId, teamId],
  )
  await query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [seed.threadId, channelId],
  )
  return seed
}

dbTest('a resumed thread stream replays every durable event above its watermark, skipping the live-only ones',
  async () => {
    const hub = await createRealtimeHub({
      databaseUrl: databaseUrl!,
      poolMax: 3,
      poolMin: 0,
      // Only consulted for a connection that carries a viewer; this one
      // registers by thread id, exactly like `api-drain.test.ts`.
      prisma: {} as unknown as PrismaClient,
    })
    const query = (text: string, values: unknown[]) => hub.pool.query(text, values)
    const seed = await seedThread(query)

    try {
      const runId = parseRunId(seed.runId)
      const agentId = parseAgentId(seed.agentId)
      // One run's worth of thread events, in the order a real run publishes
      // them: the working marker, the stream opener, two thought chunks and a
      // token delta, then the terminator and the marker coming back off.
      const marker = await hub.publishSse(seed.threadId, 'message.reaction', {
        agentId, emoji: '👀', messageId: randomUUID(),
      })
      const started = await hub.publishSse(seed.threadId, 'stream.start', {
        agentId, rootMessageId: null, runId, threadId: parseThreadId(seed.threadId),
      })
      const reasoning = await hub.publishSse(seed.threadId, 'stream.reasoning', {
        chunkId: '4242', content: 'thinking about the channel list', runId,
      })
      const toolLine = await hub.publishSse(seed.threadId, 'stream.thinking.tool', {
        chunkId: '4243', content: 'channel_list: limit 5', runId,
      })
      const delta = await hub.publishSse(seed.threadId, 'stream.delta', {
        content: 'the team has a handful of channels', runId,
      })
      const done = await hub.publishSse(seed.threadId, 'stream.done', {
        agentId, content: 'the team has a handful of channels', messageId: randomUUID(), runId,
      })
      const cleared = await hub.publishSse(seed.threadId, 'message.reaction', {
        agentId, emoji: '👀', messageId: randomUUID(),
      })

      // The client saw the marker and the opener live, then its replica died.
      const recorder = createRecorder()
      const connection = await hub.addSseConnection(
        seed.threadId,
        recorder.sink,
        String(started.sequence),
      )

      // (1) Every replayable row above the watermark, in id order, and nothing
      // at or below it. `stream.done` is the one that matters most: it is the
      // run terminator, and a client that never receives it keeps a pending
      // bubble on screen forever.
      assert.deepEqual(
        recorder.ids(),
        [done.sequence, cleared.sequence],
        'the resume must replay exactly the durable events above the watermark, in id order',
      )
      assert.ok(
        !recorder.frames().includes(`id: ${marker.sequence}\n`),
        'an event at or below the watermark must not be replayed',
      )

      // (2) The live-only rows are skipped, not re-emitted: replaying a delta
      // or a thought chunk against a finished run is the zombie bubble the skip
      // exists to prevent. Their content is durable elsewhere (the finished
      // message, and `GET /api/threads/:id/runs/:runId/thinking`).
      for (const [label, event] of [
        ['stream.reasoning', reasoning],
        ['stream.thinking.tool', toolLine],
        ['stream.delta', delta],
      ] as const) {
        assert.ok(
          !recorder.frames().includes(`id: ${event.sequence}\n`),
          `${label} is live-only and must not be replayed from the backlog`,
        )
      }

      // …and the watermark still moved past them, so the stream carries on from
      // the real head of the log rather than re-sending what it just skipped.
      assert.equal(
        connection.kind === 'thread' ? connection.lastSequence : -1,
        cleared.sequence,
        'the watermark must end at the highest persisted id, skipped rows included',
      )

      const next = await hub.publishSse(seed.threadId, 'stream.done', {
        agentId, content: 'a second run finished', messageId: randomUUID(), runId,
      })
      const deadline = Date.now() + 15_000
      while (!recorder.ids().includes(next.sequence) && Date.now() < deadline) {
        await delay(25)
      }
      assert.deepEqual(
        recorder.ids(),
        [done.sequence, cleared.sequence, next.sequence],
        'a live event after the replay must arrive exactly once, with nothing re-sent',
      )

      hub.removeSseConnection(connection)
    } finally {
      // Cascades to the project, team, channel, thread and its stream events —
      // never a global DELETE, which would take a concurrent suite's rows.
      await hub.pool.query('DELETE FROM organizations WHERE id = $1', [seed.organizationId])
      await hub.close()
    }
  })
