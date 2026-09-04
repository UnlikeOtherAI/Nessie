import assert from 'node:assert/strict'
import test from 'node:test'

import { registerGmailDraftRoutes } from '../src/routes/gmail-drafts.js'
import { IDS, localOwner, makeApp, seedTenants } from './conformance/harness.js'
import { TenantStore } from './conformance/tenant-store.js'

const approvalId = '00000000-0000-4000-8000-0000000000d2'

const seedApproval = (
  store: TenantStore,
  overrides: { action?: string; expiresAt?: Date; requiredApproverUserId?: string } = {},
) => {
  seedTenants(store)
  store.seed('approvalRequest', [{
    action: overrides.action ?? 'tool.invoke',
    agentId: IDS.agentA,
    argsHash: 'frozen-args',
    context: { approvedGoogleConnectionId: IDS.connectionA },
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    id: approvalId,
    organizationId: IDS.orgA,
    requiredApproverUserId: overrides.requiredApproverUserId ?? IDS.userA,
    status: 'pending',
    toolName: 'gmail_draft_send',
  }])
}

const requestGrantFromApproval = async (store: TenantStore) => {
  const app = makeApp(registerGmailDraftRoutes, store, localOwner())
  try {
    return await app.inject({
      method: 'POST',
      payload: { approvalId, duration: 'today' },
      url: '/api/gmail/send-grants/from-approval',
    })
  } finally {
    await app.close()
  }
}

test('a standing-consent shortcut refuses a wrong pinned approver', async () => {
  const store = new TenantStore()
  seedApproval(store, { requiredApproverUserId: IDS.userB })
  const response = await requestGrantFromApproval(store)
  assert.equal(response.statusCode, 404)
})

test('a standing-consent shortcut refuses an expired approval', async () => {
  const store = new TenantStore()
  seedApproval(store, { expiresAt: new Date(Date.now() - 60_000) })
  const response = await requestGrantFromApproval(store)
  assert.equal(response.statusCode, 404)
})

test('a standing-consent shortcut accepts only tool-invocation approvals', async () => {
  const store = new TenantStore()
  seedApproval(store, { action: 'agent.todo.publish' })
  const response = await requestGrantFromApproval(store)
  assert.equal(response.statusCode, 404)
})
