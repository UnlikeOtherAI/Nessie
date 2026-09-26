import assert from 'node:assert/strict'
import test from 'node:test'

import {
  localCommandPolicyOf, localCommandPolicyPermits, newLocalCommandPolicy, parseLocalCommandPolicy,
} from '../src/command-policy.js'
import { parseConfigurationInput } from '../src/configuration-input.js'

test('new connections allow commands; a denylist always wins', () => {
  const state = { descriptor: {}, commandPolicy: newLocalCommandPolicy() }
  assert.equal(localCommandPolicyPermits(state, 'git', ['status']), true)
  state.commandPolicy.denylist = ['git push *']
  assert.equal(localCommandPolicyPermits(state, 'git', ['push', '--force']), false)
  assert.equal(localCommandPolicyPermits(state, 'git', ['status']), true)
  state.commandPolicy.mode = 'allowlist'
  state.commandPolicy.allowlist = ['git *']
  assert.equal(localCommandPolicyPermits(state, 'git', ['push']), false)
  assert.equal(localCommandPolicyPermits(state, 'node', []), false)
})

test('legacy restrictions remain and separate team policies cannot mutate one another', () => {
  const legacy = { descriptor: { commandAllowlist: ['git status *'] } }
  assert.equal(localCommandPolicyPermits(legacy, 'git', ['push']), false)
  assert.equal(localCommandPolicyPermits({ descriptor: {} }, 'git', ['status']), false)
  const first = newLocalCommandPolicy()
  const second = newLocalCommandPolicy()
  first.denylist.push('git *')
  assert.deepEqual(second.denylist, [])
  const projected = localCommandPolicyOf(legacy)
  projected.allowlist.push('node *')
  assert.deepEqual(legacy.descriptor.commandAllowlist, ['git status *'])
})

test('local command input refuses malformed and ambiguous rules', () => {
  assert.throws(() => parseLocalCommandPolicy({ mode: 'all', allowlist: [], denylist: [], ignored: true }))
  assert.throws(() => parseLocalCommandPolicy({ mode: 'all', allowlist: [], denylist: ['*'] }))
  assert.throws(() => parseLocalCommandPolicy({ mode: 'allowlist', allowlist: ['git *', 'git  *'], denylist: [] }))
  assert.equal(localCommandPolicyPermits({ descriptor: {}, commandPolicy: newLocalCommandPolicy() }, '/bin/sh', []), false)
})

test('local configuration parses machine rules and preserves omitted settings', () => {
  const base = { operationKeys: ['file.read'], workspaceFolders: [{ name: 'work', path: '/work' }] }
  assert.equal(parseConfigurationInput(JSON.stringify(base)).commandPolicy, undefined)
  const policy = { mode: 'all', allowlist: [], denylist: ['git push *'] }
  assert.deepEqual(parseConfigurationInput(JSON.stringify({ ...base, commandPolicy: policy })).commandPolicy, policy)
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, commandPolicy: null })))
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, codingSessions: {}, terminalProgram: {} })))
})
