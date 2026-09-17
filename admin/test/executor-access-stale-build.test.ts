import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError, createApiClient } from '@nessie/client-core'

import { ExecutorAccessViewWithLocalMcpSchema } from '../src/facades/executors/local-mcp.js'
import { accessErrorLabel } from '../src/components/features/executors/ExecutorDetailPanels.js'

/**
 * The failure this pins actually happened, on a real machine, and it was
 * invisible.
 *
 * A Windows desktop shell built with the embedded admin is frozen at its build:
 * it carries its own copy of this bundle and has no way to learn it is stale.
 * The API is deployed continuously. When the control plane began projecting
 * `workspaceFolders` on each descriptor revision, that frozen bundle's strict
 * schema refused the whole access view, the query failed, and
 * `ExecutorDetailPanels` — which took the *data* rather than the query —
 * rendered the refusal as a fact: "private=unknown, project=none,
 * organization=none", with every management form silently absent because
 * `canManage` reads `false` on `undefined`.
 *
 * The person at that screen was an organisation owner and the executor's own
 * private admin. Nothing on the page said so, and nothing said the app was the
 * problem, so the only available reading was "I am not allowed to administer
 * this" — the precise lie `QueryState` exists to prevent.
 *
 * The schema stays strict: `ExecutorAccessViewResponseSchema` is aliased by
 * `api/src/contracts/executors.ts` for the server's *outbound* projection,
 * where strictness is the disclosure guard described in
 * `docs/standards/team-model.md`. Loosening it here would loosen it there.
 * What changes is that the refusal is now typed and said out loud.
 */

const accessPayload = (extra: Record<string, unknown> = {}) => ({
  canManage: true,
  effectiveAccess: { organizationRole: 'owner', privateAssignment: 'admin', projectRole: null },
  executorId: '6ee804f6-d7a9-4eb6-b357-60c81e21e8e0',
  operationGrants: [],
  privateAssignments: [],
  sessions: [],
  ...extra,
})

const clientOver = (payload: unknown) => {
  const fetchStub = async () => new Response(
    JSON.stringify({ data: payload, success: true }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  )
  const previous = globalThis.fetch
  globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch
  return {
    client: createApiClient({ baseUrl: 'https://api.example.test', token: () => 'token' }),
    restore: () => { globalThis.fetch = previous },
  }
}

const revision = (extra: Record<string, unknown> = {}) => ({
  localPolicyDigest: `sha256:${'5'.repeat(64)}`,
  operationKeys: ['file.list', 'file.read'],
  profiles: ['workspace_sandbox'],
  reviewStatus: 'pending_review',
  revision: 2,
  // The key that caused the outage. It is a known field *now*, which is the
  // point: the next one will not be.
  workspaceFolders: ['nessieworkspace'],
  ...extra,
})

test('a field this build has never heard of is refused as INVALID_RESPONSE, not as a bare ZodError', async () => {
  // Deliberately not `workspaceFolders`: this schema learned that key, so
  // asserting on it would pin the instance and retire the moment it shipped.
  // What has to stay pinned is the *class* — the next additive field the
  // control plane projects, against a client that cannot be updated in place.
  // A hand-rolled `.parse()` threw a ZodError, which carries no code, so the
  // screen could not tell "the server moved on" from "the network is down".
  const { client, restore } = clientOver(accessPayload({
    descriptorRevisions: [revision({ someFieldAddedAfterThisBuildShipped: ['x'] })],
  }))
  try {
    await assert.rejects(
      () => client.get('/api/executors/x/access', ExecutorAccessViewWithLocalMcpSchema),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError, 'the refusal must be an ApiClientError')
        assert.equal(error.code, 'INVALID_RESPONSE')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('the payload that broke the frozen build parses here, so the screen renders', async () => {
  const { client, restore } = clientOver(accessPayload({ descriptorRevisions: [revision()] }))
  try {
    const view = await client.get('/api/executors/x/access', ExecutorAccessViewWithLocalMcpSchema)
    assert.equal(view.canManage, true)
    assert.equal(view.effectiveAccess.organizationRole, 'owner')
    assert.deepEqual(view.descriptorRevisions?.[0]?.workspaceFolders, ['nessieworkspace'])
  } finally {
    restore()
  }
})

test('the stale-build refusal names the remedy Retry cannot reach', () => {
  const label = accessErrorLabel(new ApiClientError('bad', 'INVALID_RESPONSE', 200))
  // Retrying a stale client forever produces the same refusal, so the sentence
  // has to send the person somewhere else.
  assert.match(label, /older than the server/)
  assert.match(label, /Update or reinstall/)
})

test('any other failure keeps the ordinary sentence, because Retry is the right move', () => {
  for (const error of [new Error('network down'), new ApiClientError('nope', 'FORBIDDEN', 403), undefined]) {
    const label = accessErrorLabel(error)
    assert.match(label, /could not be loaded/)
    assert.doesNotMatch(label, /older than the server/)
  }
})
