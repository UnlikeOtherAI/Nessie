import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutorCapabilityDescriptorSchema, ExecutorDaemonHeartbeatResponseSchema } from '../executor.js'
import {
  executorCodingSessionOwnerKeyInput,
  ExecutorCodingSessionsFactsSchema,
  ExecutorCodingSessionSummarySchema,
} from '../executor-coding-sessions.js'
import { ExecutorLocalMcpReportSchema, ExecutorMcpCallPayloadSchema } from '../executor-mcp.js'

const digest = `sha256:${'a'.repeat(64)}`
const ownerKey = `sha256:${'b'.repeat(64)}`
const agentId = '00000000-0000-4000-8000-000000000701'
const actorUserId = '00000000-0000-4000-8000-000000000702'
const runId = '00000000-0000-4000-8000-000000000703'

const facts = {
  serverName: 'coding-sessions',
  agents: ['claude', 'codex'],
  permissionMode: { claude: 'acceptEdits', codex: 'bypassApprovalsAndSandbox' },
  allowedToolCount: 3,
  rootNames: ['nessie'],
  configDigest: digest,
}

const descriptor = {
  protocolVersion: 1,
  revision: 2,
  profiles: ['workspace_sandbox'],
  platform: { architecture: 'x64', os: 'windows', osMajorVersion: 19045 },
  supervisor: 'desktop',
  sandboxBackend: 'none',
  operationKeys: ['mcp.tools', 'mcp.call'],
  mcpServers: ['coding-sessions'],
  localPolicyDigest: digest,
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
}

test('the descriptor carries the bridge\'s power facts, and nothing looser', () => {
  const parsed = ExecutorCapabilityDescriptorSchema.parse({ ...descriptor, codingSessions: facts })
  assert.deepEqual(parsed.codingSessions, facts)
  assert.equal(ExecutorCapabilityDescriptorSchema.safeParse(descriptor).success, true, 'absent means not offered')
  for (const loose of [
    { ...facts, rootPaths: ['C:/Users/ondre'] },
    { ...facts, serverName: 'kelpie' },
    { ...facts, agents: ['claude', 'claude'] },
    { ...facts, agents: ['cursor'] },
    { ...facts, permissionMode: { claude: 'acceptEdits' } },
    { ...facts, permissionMode: { ...facts.permissionMode, cursor: 'x' } },
    { ...facts, configDigest: 'sha256:short' },
  ]) {
    assert.equal(ExecutorCodingSessionsFactsSchema.safeParse(loose).success, false, JSON.stringify(loose))
  }
})

test('the mcp.call payload stamps an owner beside runId, outside the model\'s arguments', () => {
  const args = { server: 'coding-sessions', tool: 'session_list', arguments: {} }
  assert.equal(ExecutorMcpCallPayloadSchema.safeParse({ args, runId }).success, true)
  const owner = { agentId, actorUserId }
  assert.deepEqual(ExecutorMcpCallPayloadSchema.parse({ args, runId, owner }).owner, owner)
  assert.equal(ExecutorMcpCallPayloadSchema.safeParse({ args, runId, owner: { agentId, actorUserId, role: 'x' } }).success, false)
  assert.equal(ExecutorMcpCallPayloadSchema.safeParse({ args, runId, owner: { agentId } }).success, false)
  assert.equal(ExecutorMcpCallPayloadSchema.safeParse({ args, runId, extra: true }).success, false)
  assert.equal(
    ExecutorMcpCallPayloadSchema.safeParse({ args: { ...args, owner }, runId }).success,
    false,
    'an owner inside the model\'s envelope is refused, not honoured',
  )
  assert.equal(executorCodingSessionOwnerKeyInput('exec', { agentId: 'agent', actorUserId: 'user' }), 'exec|agent|user')
})

test('the heartbeat may tell the daemon whose sessions to close', () => {
  const base = { connectionEpoch: '3', status: 'online' }
  assert.equal(ExecutorDaemonHeartbeatResponseSchema.safeParse(base).success, true)
  assert.deepEqual(ExecutorDaemonHeartbeatResponseSchema.parse({
    ...base, codingSessionClose: [{ ownerKey, reason: 'lease_ended' }, { ownerKey, sessionId: runId, reason: 'closed_by_person' }],
  }).codingSessionClose?.length, 2)
  for (const bad of [
    [{ ownerKey: 'owner-a', reason: 'lease_ended' }],
    [{ ownerKey, reason: 'Because the lease ended.' }],
    [{ ownerKey, reason: 'lease_ended', note: 'x' }],
  ]) {
    assert.equal(ExecutorDaemonHeartbeatResponseSchema.safeParse({ ...base, codingSessionClose: bad }).success, false)
  }
})

test('only the coding-sessions report carries sessions, and a session carries no transcript', () => {
  const session = {
    sessionId: runId, ownerKey, title: 'Fix the flaky test', status: 'working', agent: 'claude', root: 'nessie',
    updatedAt: '2026-09-23T10:00:00.000Z',
  }
  const status = (server: string) => ({
    server, available: true, observedAt: '2026-09-23T10:00:00.000Z', codingSessions: [session],
  })
  assert.equal(ExecutorLocalMcpReportSchema.safeParse([status('coding-sessions')]).success, true)
  assert.equal(ExecutorLocalMcpReportSchema.safeParse([status('kelpie')]).success, false)
  assert.equal(ExecutorCodingSessionSummarySchema.safeParse({ ...session, lastAssistant: 'I edited…' }).success, false)
  assert.equal(ExecutorCodingSessionSummarySchema.safeParse({ ...session, title: 'x'.repeat(121) }).success, false)
})
