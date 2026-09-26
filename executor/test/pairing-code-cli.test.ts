import assert from 'node:assert/strict'
import test from 'node:test'

import { pairingUsesWindowsTray, runPairingCodeCli } from '../src/pairing-code-cli.js'

test('pairing on Windows guides an ordinary terminal to the service tray before touching local state', async (context) => {
  let output = ''
  context.mock.method(process.stdout, 'write', (chunk: string) => { output += chunk; return true })
  assert.equal(await runPairingCodeCli([], 'win32'), true)
  assert.equal(await runPairingCodeCli(['pair'], 'win32'), true)
  assert.equal(await runPairingCodeCli(['pairing-start'], 'win32'), true)
  assert.equal(output, 'Open Nessie Executor in the Windows tray and choose Add team.\n'.repeat(3))
})

test('pairing keeps explicit operator state and JSON native commands on their configured path', () => {
  for (const args of [
    ['pair', '--state-dir', 'C:/operator/executor'],
    ['pair', '--cli'],
    ['pairing-start', '--json', '--pairing-input-stdin'],
    ['pairing-status', '--json'],
    ['pair', '--enrollment', 'existing-enrollment'],
  ]) assert.equal(pairingUsesWindowsTray(args, 'win32'), false)
  assert.equal(pairingUsesWindowsTray(['pair'], 'linux'), false)
  assert.equal(pairingUsesWindowsTray(['pair'], 'darwin'), false)
})

test('replacement never implicitly selects an existing account', async () => {
  await assert.rejects(runPairingCodeCli(['pair', '--replace'], 'linux'), /Choose the connection to replace/)
})

test('pairing refuses a missing operator directory before falling back to a default pairing', async () => {
  await assert.rejects(runPairingCodeCli(['pair', '--state-dir'], 'win32'), /missing a required setting/)
  await assert.rejects(runPairingCodeCli(['pair', '--state-dir', '--json'], 'win32'), /missing a required setting/)
})
