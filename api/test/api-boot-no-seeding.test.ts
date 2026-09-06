import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

/**
 * Boot connects and listens — nothing else
 * (docs/standards/horizontal-scaling.md §5). `buildApp` used to seed every
 * organisation's default policy rules, backfill protected-MCP tool grants and
 * provision Personal Assistant default grants before `listen()`, on every
 * replica; `startApiServer` then ran the credential sweep (horizontal-scaling
 * audit 1.4 and 1.7). All four moved to `runReconcile`, which the deploy runs
 * once after `migrate deploy`.
 *
 * This is a source assertion rather than a boot, deliberately: calling
 * `buildApp()` in-process starts a realtime hub, a LISTEN client and the
 * maintenance timers, and the test process then never exits. The behaviour is
 * verified live instead — a `selfHosted` API started against a database whose
 * organisation has no policy rules still has none after it answers
 * `/api/health/ready`. What this file guards is the regression: that nobody
 * puts the work back on the boot path.
 */
const bootSource = readFileSync(
  resolve(import.meta.dirname, '../src/index.ts'),
  'utf8',
)

const RECONCILE_ONLY_WORK = [
  'seedDefaultPolicies',
  'backfillProtectedMcpToolGrants',
  'reconcilePersonalAssistantDefaultToolGrantsAtStartup',
  'runRefreshCredentialSweep',
]

for (const symbol of RECONCILE_ONLY_WORK) {
  test(`boot does not run ${symbol}`, () => {
    assert.equal(
      bootSource.includes(symbol),
      false,
      `${symbol} belongs to runReconcile (api/src/db/reconcile-cli.ts), not to boot`,
    )
  })
}

test('the only boot-time reconcile is the local-mode exception', () => {
  const calls = [...bootSource.matchAll(/runReconcile\(/g)]
  assert.equal(calls.length, 1, 'exactly one runReconcile call on the boot path')

  const localGate = bootSource.indexOf("if (config.mode === 'local')")
  assert.ok(localGate >= 0, 'the local-mode gate is present')
  assert.ok(
    calls[0]!.index! > localGate,
    'the reconcile call sits inside the local-mode branch',
  )
})
