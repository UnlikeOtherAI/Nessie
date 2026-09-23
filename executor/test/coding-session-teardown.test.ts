import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { ExecutorCodingSessionSummarySchema } from '@nessie/schemas'

import {
  CODING_SESSIONS_CONFIG_DIGEST_ENV,
  codingSessionsConfigDigest,
  normalizeCodingSessionsConfig,
} from '../src/coding-session/config.js'
import { createCodingSessionsDaemon } from '../src/coding-sessions-daemon.js'
import { codingSessionsFacts } from '../src/coding-sessions-policy.js'
import { createCodingHarness, type CodingHarness } from './coding-session-harness.js'

/**
 * The daemon's teardown and report against a real bridge: a heartbeat's
 * `codingSessionClose` for one owner closes that owner's sessions and leaves
 * everyone else's running, a close naming one session closes only it, and the
 * report lists open sessions by title and owner with nothing they said.
 */

const OWNER_A = `sha256:${'a'.repeat(64)}`
const OWNER_B = `sha256:${'b'.repeat(64)}`

const daemonFor = async (harness: CodingHarness) => {
  const config = normalizeCodingSessionsConfig(JSON.parse(await readFile(harness.configPath, 'utf8')))
  const digest = codingSessionsConfigDigest(config)
  return createCodingSessionsDaemon({
    executorId: '00000000-0000-4000-8000-000000000901',
    facts: codingSessionsFacts(config, digest),
    // The harness started this same bridge; the daemon needs only its name and its reviewed digest.
    servers: [{
      name: 'coding-sessions',
      command: [process.execPath, 'index.ts', 'serve-coding-session-mcp', '--config', harness.configPath],
      env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: digest },
    }],
    sessions: harness.manager,
  })
}

test('a heartbeat close ends one owner\'s sessions, or one session, and the report says what is open', {
  timeout: 180_000,
}, async () => {
  const harness = await createCodingHarness({ reviewedDigest: true })
  try {
    const daemon = await daemonFor(harness)
    const start = async (owner: string, prompt: string) => {
      const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt }, { owner })
      const sessionId = started.body.sessionId as string
      await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', owner)
      return sessionId
    }
    const a1 = await start(OWNER_A, 'Fix the flaky login test\nthen open a PR')
    const a2 = await start(OWNER_A, 'Upgrade the lint config')
    const b1 = await start(OWNER_B, 'Owner B work')

    const report = await daemon.report()
    assert.deepEqual(new Set(report?.map((session) => session.sessionId)), new Set([a1, a2, b1]))
    for (const session of report ?? []) {
      assert.equal(ExecutorCodingSessionSummarySchema.safeParse(session).success, true)
    }
    assert.deepEqual(report?.find((session) => session.sessionId === a1), {
      ...report?.find((session) => session.sessionId === a1),
      ownerKey: OWNER_A, title: 'Fix the flaky login test', agent: 'claude', root: 'work', status: 'waiting_for_input',
    })
    const listed = await harness.call('session_list_all', {}, { owner: OWNER_A })
    assert.equal(listed.code, 'coding_session_daemon_only', 'a model call cannot read every owner\'s sessions')

    await daemon.close([{ ownerKey: OWNER_A, sessionId: a2, reason: 'closed_by_person' }])
    await harness.waitForStatus(a2, (body) => body.status === 'closed', OWNER_A)
    assert.equal((await harness.call('session_status', { sessionId: a1 }, { owner: OWNER_A })).body.status, 'waiting_for_input')

    await daemon.close([{ ownerKey: OWNER_A, reason: 'lease_ended' }])
    await harness.waitForStatus(a1, (body) => body.status === 'closed', OWNER_A)
    const other = await harness.call('session_status', { sessionId: b1 }, { owner: OWNER_B })
    assert.equal(other.body.status, 'waiting_for_input', 'another owner\'s session keeps running')
    const after = await daemon.report()
    assert.deepEqual(after?.map((session) => session.sessionId), [b1], 'closed sessions leave the report')
  } finally {
    await harness.cleanup()
  }
})
