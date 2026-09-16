// The pairing command must pair into the directory the service will read.
//
// This is held against the unit file rather than against a copy of the string,
// because a copy is what failed: the page printed `$HOME/.nessie-executor`,
// the unit read `%h/.local/state/nessie-executor/%i`, and
// `nessie-executor enable` refused the mismatch. Nothing compared the two, so
// the only symptom was a person who had paired successfully and could not
// start the service. Reading the unit means the next person to move that
// directory has to move this command with it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildPairingCommand, pairingStateDirectory } from '../src/lib/executor-pairing'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UNIT = resolve(REPO_ROOT, 'executor', 'packaging', 'linux', 'nessie-executor@.service')

const EXECUTOR_ID = '8b2d4c60-0000-4000-8000-000000000002'

/** `--state-dir` out of the unit's ExecStart, with systemd's specifiers expanded. */
const stateDirectoryFromUnit = (executorId: string): string => {
  const unit = readFileSync(UNIT, 'utf8')
  const execStart = /^ExecStart=(.+)$/mu.exec(unit)?.[1]
  assert.ok(execStart, 'the unit must declare an ExecStart')
  const stateDir = /--state-dir\s+(\S+)/u.exec(execStart)?.[1]
  assert.ok(stateDir, 'the unit must pass --state-dir')
  // %h is the user's home, %i the instance name — here, the executor id.
  return stateDir.replace('%h', '$HOME').replace('%i', executorId)
}

test('the pairing command pairs into the directory the systemd unit reads', () => {
  assert.equal(pairingStateDirectory(EXECUTOR_ID), stateDirectoryFromUnit(EXECUTOR_ID))
})

test('the command carries that directory, the enrolment and the challenge', () => {
  const command = buildPairingCommand({
    apiOrigin: 'https://api.nessie.works',
    challenge: 'Zm9vYmFyLWNoYWxsZW5nZQ',
    enrollmentId: '3f1c9a2e-0000-4000-8000-000000000001',
    executorId: EXECUTOR_ID,
  })
  assert.match(command, /^nessie-executor pair /u)
  assert.ok(command.includes(`--state-dir "${stateDirectoryFromUnit(EXECUTOR_ID)}"`))
  assert.ok(command.includes('--enrollment 3f1c9a2e-0000-4000-8000-000000000001'))
  assert.ok(command.includes('--challenge Zm9vYmFyLWNoYWxsZW5nZQ'))
  // The old bug in one line: a fixed home-directory path that `enable` refuses.
  assert.ok(!command.includes('$HOME/.nessie-executor"'))
})

// The companion check — that `Documentation=` names a path the public site
// actually declares — is deliberately not here. `web/src/pages/registry.ts`,
// which is the list that decides whether `/docs/executors` exists at all, is
// not on main yet; a test that reads it would pass here only by being skipped,
// and a skipped test is one that has stopped checking. It belongs with the
// registry, in the change that introduces it.
