// Multi-instance CI smoke: `smoke.ts`'s scenario driven through TWO API processes
// behind a round-robin proxy while TWO worker processes claim from one Postgres —
// POST /api/threads/:id/messages on instance A → run.execute → the worker that
// wins the claim → tool call → completion, read back on instance B.
// Run: pnpm --filter @nessie/worker test:smoke:multi [--chaos] [--verbose]
// Needs api/dist + worker/dist and a DEDICATED, freshly migrated Postgres at
// DATABASE_URL: it bootstraps the owner over HTTP, which only works while no
// user exists, so it cannot share a database the way smoke.ts can.
// `--chaos` adds the Phase 0.4 kill steps (SIGTERM one worker mid-run, one API
// mid-stream) and asserts the durability properties the horizontal-scaling plan
// names: (a) no duplicate agent message, (b) no unfinished run without a live
// lease, (c) SSE resumes with no sequence gap, and (d) the killed worker left a
// crash checkpoint for its successor to resume from (phase 3.1). The CI job
// runs the chaos step advisory-only.
import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHAOS = process.argv.includes('--chaos')
const VERBOSE = process.argv.includes('--verbose') || process.env.SMOKE_MULTI_LOGS === '1'
const PORT_BASE = Number(process.env.SMOKE_MULTI_PORT_BASE ?? 5481)
const API_PORTS = [PORT_BASE + 1, PORT_BASE + 2]
const PROXY_URL = `http://127.0.0.1:${PORT_BASE}`
const AUTH_SECRET = 'multi-instance-smoke-secret-multi-instance-smoke'
const SCENARIO = 'reasoning-tool-answer'
const EXPECTED_ANSWER =
  'The team has a handful of channels, including the one we are talking in right now.'
// Long enough that a signal lands mid-inference and the draining process cannot
// finish the run on its way out.
const CHAOS_TURN_LATENCY_MS = 8_000

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://nessie:nessie@localhost:55432/nessie'
process.env.DATABASE_URL = DATABASE_URL
process.env.NESSIE_DB_URL = DATABASE_URL

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
type Probe = () => Promise<boolean> | boolean

const waitFor = async (label: string, probe: Probe, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await sleep(50)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)
}

type Managed = { child: ChildProcess; label: string; log: () => string }
const started: Managed[] = []
// A throw before teardown would orphan a process the next run would then adopt.
process.once('exit', () => { for (const managed of started) managed.child.kill('SIGKILL') })
const assertPortFree = (port: number): Promise<void> => new Promise((done, fail) => {
  const probe = http.createServer()
  probe.once('error', () => fail(new Error(`port ${port} is in use — move SMOKE_MULTI_PORT_BASE`)))
  probe.listen(port, '127.0.0.1', () => probe.close(() => done()))
})

const startProcess = (label: string, entry: string, env: Record<string, string>): Managed => {
  if (!existsSync(entry)) {
    throw new Error(`${label} cannot start: ${entry} is missing — run pnpm exec turbo run build`)
  }
  const child = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks: string[] = []
  const record = (chunk: Buffer): void => {
    chunks.push(String(chunk))
    if (VERBOSE) process.stdout.write(`[${label}] ${String(chunk)}`)
  }
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)
  const managed = { child, label, log: () => chunks.join('') }
  started.push(managed)
  return managed
}

// SIGTERM, then the escalation every platform performs: `docker stop` and Cloud
// Run both SIGKILL once their grace expires, compressed here to two seconds. A
// handler that outlives the grace would otherwise quietly finish its work.
const signalProcess = async (managed: Managed, signal: NodeJS.Signals): Promise<void> => {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) return
  const exit = new Promise<void>((done) => managed.child.once('exit', () => done()))
  managed.child.kill(signal)
  await Promise.race([exit, sleep(2_000)])
  if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill('SIGKILL')
  await exit
}

type Proxy = { close: () => Promise<void>; routes: number[] }

// Alternates every request between the two API instances and fails over when an
// upstream refuses the connection — which is what lets a client survive the
// chaos step's API kill and is what a real load balancer does.
const startProxy = async (ports: number[]): Promise<Proxy> => {
  const routes: number[] = []
  let cursor = 0
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const attempt = (remaining: number): void => {
        const index = cursor % ports.length
        cursor += 1
        routes.push(index)
        const port = ports[index]!
        const upstream = http.request(
          {
            agent: false,
            headers: { ...request.headers, host: `127.0.0.1:${port}` },
            host: '127.0.0.1',
            method: request.method,
            path: request.url,
            port,
          },
          (proxied) => {
            response.writeHead(proxied.statusCode ?? 502, proxied.headers)
            response.flushHeaders()
            response.socket?.setNoDelay(true)
            // An upstream that dies mid-response aborts without ending the pipe;
            // a real proxy closes the client connection, so this one does too.
            proxied.once('close', () => { if (!response.writableEnded) response.end() })
            proxied.pipe(response)
          },
        )
        upstream.once('error', () => {
          if (response.headersSent) return response.end()
          routes.pop()
          if (remaining > 0) return attempt(remaining - 1)
          response.writeHead(502)
          response.end()
        })
        if (body.length > 0) upstream.write(body)
        upstream.end()
      }
      attempt(ports.length)
    })
  })
  await new Promise<void>((done) => { server.listen(PORT_BASE, '127.0.0.1', done) })
  return {
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
    routes,
  }
}

type ApiReply = { body: Record<string, unknown>; status: number }

const call = async (method: string, path: string, token: string | null, body?: unknown): Promise<ApiReply> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = `Bearer ${token}`
  const response = await fetch(`${PROXY_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body), headers, method,
  })
  const text = await response.text()
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: response.status }
}

type SseClient = { close: () => void; ended: Promise<void>; ids: number[] }

// Deliberately raw `http`: the assertion is about the `id:` sequence the server
// actually put on the wire, which EventSource hides.
const openSse = (path: string, token: string, lastEventId?: number): SseClient => {
  const ids: number[] = []
  let settle: () => void = () => undefined
  const ended = new Promise<void>((done) => { settle = done })
  const headers: Record<string, string> = { accept: 'text/event-stream', authorization: `Bearer ${token}` }
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId)
  let buffer = ''
  const request = http.request(`${PROXY_URL}${path}`, { agent: false, headers }, (response) => {
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('id:')) ids.push(Number(line.slice(3).trim()))
      }
    })
    response.on('end', settle)
    response.on('error', settle)
  })
  request.on('error', settle)
  request.end()
  return { close: () => { request.destroy(); settle() }, ended, ids }
}

type Check = { detail: string; name: string; ok: boolean }
type Seed = { messageId: string; threadId: string }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail: string): void => { checks.push({ detail, name, ok }) }

const main = async (): Promise<void> => {
  const { createMockLlmServer, loadScenario } = await import('@nessie/mock-llm')
  const base = await loadScenario(SCENARIO)
  const scenario = {
    ...base,
    turns: base.turns.map((turn, index) =>
      (index === 0 && CHAOS ? { ...turn, latencyMs: CHAOS_TURN_LATENCY_MS } : turn)),
  }
  for (const port of [PORT_BASE, ...API_PORTS]) await assertPortFree(port)
  // One mock server per worker: its counter tells the chaos step who is running.
  const mocks = [await createMockLlmServer({ scenario }), await createMockLlmServer({ scenario })]

  // Outside `local` the API and worker refuse to boot without a DeepSignal app key
  // and a UOA delegated-identity configuration; neither is exercised here, so
  // these ephemeral values exist only to clear that boot gate.
  const pem = String(generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }))
  // selfHosted, not local: local mode embeds a worker in every API process, which
  // would put four claimants on run.execute and make the chaos step meaningless.
  const shared = {
    DEEPSIGNAL_MCP_APP_KEY: `dsk_${randomUUID().replaceAll('-', '')}`,
    NESSIE_AUTH_SECRET: AUTH_SECRET,
    NESSIE_MODE: 'selfHosted',
    NESSIE_MODEL_API_KEY: 'multi-instance-smoke',
    NESSIE_MODEL_PROVIDER: 'openai',
    UOA_CLIENT_SECRET: randomUUID(),
    UOA_CONFIG_JWT_KID: 'multi-instance-smoke',
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(pem).toString('base64'),
    UOA_CONFIG_URL: 'http://127.0.0.1:1/config',
    UOA_DOMAIN: 'multi-instance-smoke.invalid',
  }
  const apis = API_PORTS.map((port, index) =>
    startProcess(`api-${index + 1}`, resolve(REPO_ROOT, 'api', 'dist', 'index.js'), {
      ...shared,
      NESSIE_API_HOST: '127.0.0.1',
      NESSIE_API_PORT: String(port),
      // Unreachable on purpose: the API's best-effort model calls must fail fast
      NESSIE_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
    }))
  await Promise.all(API_PORTS.map((port, index) => waitFor(
    `api-${index + 1} on ${port}`,
    () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false),
    180_000,
  )))

  // The one-time bootstrap token lives in API process memory (audit finding 1.2),
  // so both instances mint their own and only one can be consumed — this exchange
  // goes straight at instance 1. Phase 2.2 is what makes it round-robin safe.
  const tokenMatch = /\/bootstrap\?token=([0-9a-f-]{36})/.exec(apis[0]!.log())
  if (!tokenMatch) throw new Error(`api-1 printed no bootstrap URL — is ${DATABASE_URL} a fresh database?`)
  const owner = {
    bootstrapToken: tokenMatch[1],
    displayName: 'Multi Instance Smoke',
    email: `multi-smoke-${randomUUID().slice(0, 8)}@example.com`,
    password: 'Multi-Instance-Smoke-1!',
  }
  const bootstrap = await fetch(`http://127.0.0.1:${API_PORTS[0]}/api/auth/bootstrap`, {
    body: JSON.stringify(owner), headers: { 'content-type': 'application/json' }, method: 'POST',
  })
  const bootstrapBody = (await bootstrap.json()) as { data?: { token?: string } }
  const token = bootstrapBody.data?.token
  if (!token) throw new Error(`bootstrap failed (${bootstrap.status}): ${JSON.stringify(bootstrapBody)}`)

  const workers = mocks.map((mock, index) =>
    startProcess(`worker-${index + 1}`, resolve(REPO_ROOT, 'worker', 'dist', 'index.js'), {
      ...shared,
      NESSIE_MODEL_BASE_URL: `${mock.url}/v1`,
      // The SIGKILL escalation below is compressed to two seconds, while the
      // production drain deadline is 25 s and the run-drain grace 5 s — so at
      // the defaults the chaos step can only ever observe the SIGKILL, never a
      // drain. Compressed to match, which is what puts the abandoned job back
      // to `pending` inside the window instead of leaving it on a dead lease.
      ...(CHAOS
        ? { NESSIE_RUN_DRAIN_GRACE_MS: '300', NESSIE_WORKER_DRAIN_TIMEOUT_MS: '300' }
        : {}),
    }))
  const ready = (w: Managed): boolean => /"status": "ready"/.test(w.log())
  await Promise.all(workers.map((w) => waitFor(`${w.label} ready`, () => ready(w), 180_000)))

  const proxy = await startProxy(API_PORTS)
  const { disconnectPrismaClient, enqueueQueueJob, getPrismaClient } = await import('@nessie/db')
  const { createPgPool } = await import('@nessie/runtime')
  const { RunExecuteJobPayloadSchema } = await import('@nessie/schemas')
  const prisma = getPrismaClient()
  const pool = createPgPool(DATABASE_URL, { max: 4, min: 0 })
  const runIds: string[] = []

  // The only tenant this session's JWT can reach; assert it rather than assume it.
  const orgs = await prisma.organization.findMany({ select: { id: true } })
  if (orgs.length !== 1) throw new Error(`expected one organization on a fresh database, found ${orgs.length}`)
  const organizationId = orgs[0]!.id
  const ownerId = (await prisma.user.findFirstOrThrow({ select: { id: true } })).id
  const general = await prisma.channel.findFirstOrThrow({
    select: { projectId: true, teamId: true }, where: { organizationId, slug: 'general' },
  })
  const suffix = randomUUID().slice(0, 8)
  const agent = await prisma.agent.create({
    data: {
      model: 'mock-model', name: `multi-smoke-agent-${suffix}`, organizationId, provider: 'openai',
      systemPrompt: 'You are a deterministic smoke-test assistant. Keep answers short.',
    },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `multi-smoke-${suffix}`, organizationId, projectId: general.projectId,
      slug: `multi-smoke-${suffix}`, teamId: general.teamId,
    },
  })

  // Trigger message over HTTP through the proxy; run row and queue job as smoke.ts.
  const seedThread = async (): Promise<Seed> => {
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const content = 'Which channels does this team have?'
    const posted = await call('POST', `/api/threads/${thread.id}/messages`, token, { content })
    if (posted.status !== 201) throw new Error(`post failed (${posted.status}): ${JSON.stringify(posted.body)}`)
    const message = (posted.body['data'] as { message: { id: string } }).message
    return { messageId: message.id, threadId: thread.id }
  }

  const enqueueRun = async (seed: Seed): Promise<string> => {
    const run = await prisma.run.create({ data: { agentId: agent.id, threadId: seed.threadId } })
    const task = await prisma.task.create({
      data: {
        agentId: agent.id, organizationId, projectId: general.projectId, runId: run.id,
        title: `multi-smoke run ${run.id.slice(0, 8)}`,
      },
    })
    runIds.push(run.id)
    // The queue has one enqueue door; `PgQueueProvider` claims, it does not
    // write. The harness seeds through the same function production uses.
    await enqueueQueueJob(prisma, {
      payload: RunExecuteJobPayloadSchema.parse({
        actorContext: {
          actionContext: {
            agentId: agent.id, channelId: channel.id, correlationId: randomUUID(),
            effectiveUserId: ownerId, requestId: randomUUID(), taskId: task.id,
            teamId: general.teamId, threadId: seed.threadId,
          },
          actor: { actorId: ownerId, actorType: 'user', roles: ['owner'] },
          tenant: {
            channelId: channel.id, organizationId, projectId: general.projectId, teamId: general.teamId,
          },
        },
        agentId: agent.id,
        interactive: true,
        messageId: seed.messageId,
        runId: run.id,
        taskId: task.id,
        threadId: seed.threadId,
      }),
      topic: 'run.execute',
    })
    return run.id
  }

  const waitForTerminal = async (runId: string, timeoutMs = 90_000): Promise<string> => {
    let last = 'pending'
    await waitFor(`run ${runId} terminal`, async () => {
      last = (await prisma.run.findUniqueOrThrow({ select: { status: true }, where: { id: runId } })).status
      return ['cancelled', 'completed', 'failed'].includes(last)
    }, timeoutMs).catch(() => undefined)
    return last
  }

  // SIGTERM the worker executing a run, then the API serving an open stream.
  const runChaos = async (): Promise<void> => {
    const seen = mocks.map((mock) => mock.stats().requests)
    const seed = await seedThread()
    const runId = await enqueueRun(seed)
    let executor = -1
    await waitFor('a worker to start the chaos run', () => {
      executor = mocks.findIndex((mock, index) => mock.stats().requests > seen[index]!)
      return executor >= 0
    }, 30_000)
    console.log(`[smoke:multi] chaos: SIGTERM worker-${executor + 1} mid-run ${runId}`)
    await signalProcess(workers[executor]!, 'SIGTERM')
    const atKill = await pool.query(
      `SELECT status, locked_until FROM queue_jobs WHERE payload->>'runId' = $1`, [runId],
    )
    // What the killed worker left behind. This is the scenario phase 3.1 was
    // written for: without a crash checkpoint the successor has nothing but the
    // prompt, and re-executes every tool the dead worker already ran.
    const checkpointAtKill = await pool.query<{ recorded: number }>(
      `SELECT COALESCE(jsonb_array_length(
                jsonb_path_query_array(crash_state, '$.toolResults.keyvalue()')), 0) AS recorded
         FROM run_checkpoints WHERE run_id = $1::uuid AND crash_state IS NOT NULL`, [runId],
    )
    // The abandoned job keeps its five-minute lease, held by a dead process.
    // Production waits that out; the smoke expires it to re-claim in-window.
    await pool.query(
      `UPDATE queue_jobs SET locked_until = now() - interval '1 second'
         WHERE payload->>'runId' = $1 AND status = 'processing'`, [runId],
    )
    const status = await waitForTerminal(runId)
    const agentMessages = await prisma.message.findMany({
      select: { content: true }, where: { role: 'assistant', threadId: seed.threadId },
    })
    const contents = agentMessages.map((message) => message.content)
    const duplicates = contents.filter((content, index) => contents.indexOf(content) !== index)
    // The claim count is the replay made visible: a re-claimed run starts over.
    const claims = await pool.query<{ attempt: number }>(
      `SELECT attempt FROM queue_jobs WHERE payload->>'runId' = $1`, [runId])
    check('(a) no duplicate agent message after a worker SIGTERM', duplicates.length === 0,
      `${contents.length} agent message(s) after ${claims.rows[0]?.attempt ?? 0} claim(s),`
      + ` run ${status}, killed worker-${executor + 1}`)
    check('(d) the killed worker left a crash checkpoint to resume from',
      (checkpointAtKill.rowCount ?? 0) === 1,
      `${checkpointAtKill.rowCount ?? 0} crash checkpoint row(s) at kill,`
      + ` ${checkpointAtKill.rows[0]?.recorded ?? 0} tool result(s) recorded`)

    const stranded = await pool.query(
      `SELECT r.id FROM runs r
         LEFT JOIN queue_jobs q ON q.topic = 'run.execute' AND q.payload->>'runId' = r.id::text
        WHERE r.id = ANY($1::uuid[]) AND r.status IN ('running', 'waiting_approval')
          AND (q.status IS DISTINCT FROM 'processing' OR q.locked_until IS NULL
               OR q.locked_until <= now())`, [runIds])
    check('(b) every unfinished run still holds a live lease', stranded.rowCount === 0,
      `${stranded.rowCount ?? 0} stranded run(s); lease at kill: ${JSON.stringify(atKill.rows[0] ?? null)}`)

    const streamSeed = await seedThread()
    const path = `/api/threads/${streamSeed.threadId}/stream`
    const mark = proxy.routes.length
    const stream = openSse(path, token)
    await waitFor('stream to reach an instance', () => proxy.routes.length > mark, 15_000)
    const servedBy = proxy.routes[mark]!
    const streamRunId = await enqueueRun(streamSeed)
    await waitFor('stream events to flow', () => stream.ids.length >= 2, 60_000)
    console.log(`[smoke:multi] chaos: SIGTERM api-${servedBy + 1} mid-stream`)
    await signalProcess(apis[servedBy]!, 'SIGTERM')
    await stream.ended
    // Reconnect once the run finished, as a client would after losing its
    // instance: everything published in between has to arrive on the resume.
    await waitForTerminal(streamRunId)
    const resumed = openSse(path, token, stream.ids.at(-1))
    await sleep(2_000)
    resumed.close()

    const delivered = [...stream.ids, ...resumed.ids]
    // Everything the thread persisted from the first delivered id onward; bounding
    // by the last DELIVERED id instead would make this pass vacuously.
    const persisted = await pool.query<{ id: string }>(
      `SELECT id FROM thread_stream_events WHERE thread_id = $1 AND id >= $2 ORDER BY id`,
      [streamSeed.threadId, Math.min(...delivered)])
    const missing = persisted.rows.map((row) => Number(row.id)).filter((id) => !delivered.includes(id))
    check('(c) SSE resume replays with no sequence gap', missing.length === 0,
      `killed api-${servedBy + 1}; ${delivered.length} id(s) delivered, ${missing.length} never delivered`)
  }

  try {
    const seed = await seedThread()
    const runId = await enqueueRun(seed)
    const stream = openSse(`/api/threads/${seed.threadId}/stream`, token)
    const status = await waitForTerminal(runId)
    stream.close()
    const replies = `/api/threads/${seed.threadId}/messages?rootMessageId=${seed.messageId}`
    const listed = await call('GET', replies, token)

    const answer = await prisma.message.findFirst({
      orderBy: { createdAt: 'desc' }, where: { agentId: agent.id, role: 'assistant', threadId: seed.threadId },
    })
    const toolCalls = await prisma.toolCall.findMany({ where: { runId } })
    const ledger = await prisma.tokenLedgerEvent.findMany({ where: { runId } })
    const thinking = await prisma.runThinkingChunk.findMany({ where: { runId } })
    const task = await prisma.task.findFirstOrThrow({ select: { id: true, status: true }, where: { runId } })
    // run.timing lands in executeRunJob's `finally`, after the terminal status —
    // poll for it rather than racing it (see smoke.ts).
    let timing: Record<string, unknown> = {}
    await waitFor('run.timing event', async () => {
      const found = await prisma.taskEvent.findMany({ where: { eventType: 'run.timing', taskId: task.id } })
      timing = (found[0]?.payload ?? {}) as Record<string, unknown>
      return found.length > 0
    }, 15_000).catch(() => undefined)
    const agentRow = await prisma.agent.findUniqueOrThrow({ select: { status: true }, where: { id: agent.id } })

    const alternating = proxy.routes.length >= 3
      && proxy.routes.every((instance, index) => index === 0 || instance !== proxy.routes[index - 1])
    check('proxy alternates API instances', alternating,
      `${proxy.routes.length} requests routed as [${proxy.routes.join(',')}]`)
    check('run reaches completed', status === 'completed', `status=${status}`)
    check('scripted answer delivered', answer?.content === EXPECTED_ANSWER,
      JSON.stringify(answer?.content ?? null).slice(0, 70))
    check('answer threads under the posted message', answer?.rootMessageId === seed.messageId,
      `rootMessageId=${answer?.rootMessageId ?? 'null'}`)
    check('one successful channel_list tool call',
      toolCalls.length === 1 && toolCalls[0]?.toolName === 'channel_list' && toolCalls[0]?.success === true,
      `${toolCalls.length} tool call(s)`)
    // Two chat events, one per scripted turn. Posting the trigger message over
    // HTTP also books an embedding for memory capture, which smoke.ts never sees.
    const chatEvents = ledger.filter((event) => event.operationType === 'chat')
    check('two chat token-ledger events', chatEvents.length === 2,
      `${chatEvents.length} chat of ${ledger.length} event(s)`)
    check('run.timing recorded',
      timing['outcome'] === 'completed' && timing['inferenceCount'] === 2 && timing['toolCount'] === 1,
      `outcome=${String(timing['outcome'])} inference=${String(timing['inferenceCount'])}`)
    check('thought log captured', thinking.length >= 3, `${thinking.length} chunk(s)`)
    check('agent back to idle and task done', agentRow.status === 'idle' && task.status === 'done',
      `agent=${agentRow.status} task=${task.status}`)
    const served = mocks.map((mock) => mock.stats().requests)
    check('answer readable through the proxy', JSON.stringify(listed.body).includes(EXPECTED_ANSWER),
      `HTTP ${listed.status}; one worker served both turns (${served.join(' / ')})`)

    if (CHAOS) await runChaos()
  } finally {
    if (runIds.length > 0) {
      await pool.query(`DELETE FROM queue_jobs WHERE payload->>'runId' = ANY($1::text[])`, [runIds])
      await prisma.tokenLedgerEvent.deleteMany({ where: { runId: { in: runIds } } })
    }
    // The channel cascade takes threads, messages and runs; the agent row stays.
    await prisma.channel.delete({ where: { id: channel.id } }).catch(() => undefined)
    await proxy.close()
    await pool.end()
    await disconnectPrismaClient()
    await Promise.all(started.map((managed) => signalProcess(managed, 'SIGKILL')))
    await Promise.all(mocks.map((mock) => mock.close()))
  }
}

const report = (): never => {
  const width = Math.max(20, ...checks.map((entry) => entry.name.length))
  console.log(`\n[smoke:multi] ${CHAOS ? 'two-instance smoke + chaos' : 'two-instance smoke'}`)
  for (const entry of checks) {
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(width)}  ${entry.detail}`)
  }
  const passed = checks.filter((entry) => entry.ok).length
  console.log(`[smoke:multi] ${passed}/${checks.length} checks passed`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().then(report, (error: unknown) => {
  console.error('[smoke:multi] FAIL:', error instanceof Error ? error.stack : error)
  if (checks.length > 0) report()
  process.exit(1)
})
