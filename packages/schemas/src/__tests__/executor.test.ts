import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorAccessChangeConfirmationSchema,
  ExecutorAgentOperationGrantSchema,
  ExecutorAvailabilityCandidateSchema,
  ExecutorAvailabilityResponseSchema,
  ExecutorCapabilityDescriptorSchema,
  ExecutorCommandEnvelopeSchema,
  ExecutorFileWriteArgumentsSchema,
  ExecutorPrivateAssignmentSchema,
  ExecutorRunLaunchRequestSchema,
  ExecutorRunLaunchResponseSchema,
  ExecutorScopeSchema,
} from '../executor.js'

const ids = {
  agent: '2c85024e-a05b-4c89-8adc-36448a51d121',
  binding: '2c85024e-a05b-4c89-8adc-36448a51d122',
  change: '2c85024e-a05b-4c89-8adc-36448a51d123',
  enrollment: '2c85024e-a05b-4c89-8adc-36448a51d124',
  executor: '2c85024e-a05b-4c89-8adc-36448a51d125',
  organization: '2c85024e-a05b-4c89-8adc-36448a51d126',
  project: '2c85024e-a05b-4c89-8adc-36448a51d127',
  run: '2c85024e-a05b-4c89-8adc-36448a51d128',
  task: '2c85024e-a05b-4c89-8adc-36448a51d130',
  user: '2c85024e-a05b-4c89-8adc-36448a51d129',
}

const timestamp = '2026-08-12T12:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`

test('executor scopes allow only private, project, and organization', () => {
  assert.deepEqual(
    ExecutorScopeSchema.parse({
      kind: 'private',
      organizationId: ids.organization,
    }),
    { kind: 'private', organizationId: ids.organization },
  )
  assert.equal(
    ExecutorScopeSchema.safeParse({
      kind: 'team',
      organizationId: ids.organization,
    }).success,
    false,
  )
  assert.equal(
    ExecutorScopeSchema.safeParse({
      kind: 'project',
      organizationId: ids.organization,
    }).success,
    false,
  )
})

test('agents can use but cannot administer a private executor', () => {
  assert.deepEqual(
    ExecutorPrivateAssignmentSchema.parse({
      agentId: ids.agent,
      principalKind: 'agent',
      role: 'use',
    }),
    { agentId: ids.agent, principalKind: 'agent', role: 'use' },
  )
  assert.equal(
    ExecutorPrivateAssignmentSchema.safeParse({
      agentId: ids.agent,
      principalKind: 'agent',
      role: 'admin',
    }).success,
    false,
  )
  assert.equal(
    ExecutorPrivateAssignmentSchema.safeParse({
      principalKind: 'user',
      role: 'admin',
      userId: ids.user,
      extra: 'not-allowed',
    }).success,
    false,
  )
})

test('capability descriptors enforce the initial supported platform and known operations', () => {
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    limits: {
      maxCommandRuntimeSeconds: 300,
      maxResultBytes: 10_000,
      maxSessions: 1,
    },
    localPolicyDigest: digest,
    operationKeys: ['file.list', 'file.read'],
    platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision: 1,
  })

  assert.equal(descriptor.revision, 1)
  assert.equal(
    ExecutorCapabilityDescriptorSchema.safeParse({
      ...descriptor,
      platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    }).success,
    false,
  )
})

test('operation grants are tied to one executor and one known operation', () => {
  assert.equal(
    ExecutorAgentOperationGrantSchema.safeParse({
      agentId: ids.agent,
      authorizationRevision: 2,
      executorId: ids.executor,
      operationKey: 'workspace.promote',
      state: 'allowed',
      updatedAt: timestamp,
    }).success,
    true,
  )
  assert.equal(
    ExecutorAgentOperationGrantSchema.safeParse({
      agentId: ids.agent,
      authorizationRevision: 2,
      executorId: ids.executor,
      operationKey: 'shell.run',
      state: 'allowed',
      updatedAt: timestamp,
    }).success,
    false,
  )
})

test('workspace write arguments are bounded for the COW backend', () => {
  assert.deepEqual(
    ExecutorFileWriteArgumentsSchema.parse({
      content: 'draft',
      createParents: true,
      path: 'notes/draft.txt',
    }),
    { content: 'draft', createParents: true, path: 'notes/draft.txt' },
  )
  assert.equal(
    ExecutorFileWriteArgumentsSchema.safeParse({
      content: 'x'.repeat(65_537),
      path: 'notes/draft.txt',
    }).success,
    false,
  )
})

test('availability candidates expose opaque handles rather than executor IDs', () => {
  const candidate = ExecutorAvailabilityCandidateSchema.parse({
    expiresAt: timestamp,
    handle: 'candidate_handle_which_is_deliberately_opaque',
    operationKeys: ['file.read'],
    readiness: 'ready',
    scopeKind: 'private',
  })

  assert.equal(candidate.scopeKind, 'private')
  assert.equal('executorId' in candidate, false)
})

test('availability responses separate opaque candidates from safe explanations', () => {
  const response = ExecutorAvailabilityResponseSchema.parse({
    candidates: [],
    explanations: [{ readiness: 'unavailable', reason: 'logical_tool_ungranted' }],
  })
  assert.deepEqual(response.candidates, [])
  assert.equal(response.explanations[0]?.reason, 'logical_tool_ungranted')
})

test('a direct executor run always names an agent, opaque choice, and one operation', () => {
  const request = ExecutorRunLaunchRequestSchema.parse({
    agentId: ids.agent,
    candidateHandle: 'candidate_handle_which_is_deliberately_opaque',
    content: 'Read nested/notes.txt and summarize the first paragraph.',
    operationKey: 'file.read',
  })
  const response = ExecutorRunLaunchResponseSchema.parse({
    binding: {
      bindingId: ids.binding,
      capabilityRevision: 1,
      fence: '1',
      operationKey: request.operationKey,
      runId: ids.run,
    },
    messageId: ids.user,
    runId: ids.run,
    taskId: ids.task,
  })
  assert.equal(response.binding.operationKey, 'file.read')
  assert.equal('executorId' in response.binding, false)
})

test('command envelopes carry fences and digests rather than raw result data', () => {
  const envelope = ExecutorCommandEnvelopeSchema.parse({
    argumentDigest: digest,
    bindingFence: '4',
    bindingId: ids.binding,
    capabilityRevision: 3,
    commandId: ids.executor,
    expiresAt: timestamp,
    idempotencyKey: 'executor-command:2c85024e-a05b-4c89-8adc-36448a51d125',
    operationKey: 'file.read',
    payload: { pathHandle: 'workspace-file-1' },
  })

  assert.equal(envelope.bindingFence, '4')
  assert.equal(
    ExecutorCommandEnvelopeSchema.safeParse({
      ...envelope,
      rawTerminalOutput: 'secret',
    }).success,
    false,
  )
})

test('access confirmation requires an opaque change and confirmation token', () => {
  assert.equal(
    ExecutorAccessChangeConfirmationSchema.safeParse({
      accessChangeId: ids.change,
      confirmationToken: 'single_use_confirmation_token_for_access_change',
    }).success,
    true,
  )
  assert.equal(
    ExecutorAccessChangeConfirmationSchema.safeParse({
      accessChangeId: ids.change,
    }).success,
    false,
  )
})
