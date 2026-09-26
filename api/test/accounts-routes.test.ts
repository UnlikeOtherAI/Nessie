import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  AccountAgentGrantsSchema,
  AccountDetailSchema,
  AccountListResponseSchema,
  AgentAccountGrantsSchema,
} from '@nessie/schemas'

import { createAccountsHarness, type AccountsHarness } from './accounts-harness.js'

// The accounts read model and the one grant write, against a real database:
// every store projects into one row with one status vocabulary, a scope is
// read only by the people it belongs to, an account the viewer may not see is
// indistinguishable from one that does not exist, and the grant write reaches
// the mailbox's own access rows and refuses every kind that has no switch.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Reply = { data?: unknown; error?: { code: string } }

const get = async (h: AccountsHarness, url: string) => {
  const response = await h.app.inject({ method: 'GET', url })
  return { body: JSON.parse(response.body) as Reply, status: response.statusCode }
}

const put = async (h: AccountsHarness, url: string, payload: unknown) => {
  const response = await h.app.inject({ method: 'PUT', payload: payload as object, url })
  return { body: JSON.parse(response.body) as Reply, status: response.statusCode }
}

runDatabaseTest('a person’s own accounts, from every store, in one row shape', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const { body, status } = await get(h, '/api/accounts')
  assert.equal(status, 200)
  const { accounts } = AccountListResponseSchema.parse(body.data)
  const byId = new Map(accounts.map((account) => [account.id, account]))

  // Theirs, and only theirs: another member's Google account is not listed,
  // and neither is the team's shared mailbox — that is a company connection.
  assert.ok(byId.has(`comms:${h.ids.comms}`))
  assert.ok(!byId.has(`comms:${h.ids.commsOthers}`))
  assert.ok(byId.has(`mailbox:${h.ids.mailboxPersonal}`))
  assert.ok(!byId.has(`mailbox:${h.ids.mailboxShared}`))

  const google = byId.get(`comms:${h.ids.comms}`)!
  assert.equal(google.serviceName, 'Google Workspace')
  assert.equal(google.integration, 'google-workspace')
  assert.equal(google.status.word, 'connected')
  assert.deepEqual(google.capabilities, ['Read your email'])
  assert.ok(google.actions.includes('open_mail'))
  assert.equal(google.agents.rule, 'requester')

  const jira = byId.get(`tickets:${h.ids.tickets}`)!
  assert.equal(jira.purpose, 'tickets')
  assert.equal(jira.status.word, 'needs_attention')
  assert.equal(jira.status.sentence, 'Stopped: sign in to Jira again. Boards that sync through it are paused.')
  assert.equal(jira.agents.rule, 'not_used')

  const plan = byId.get(`ai-plan:${h.ids.plan}`)!
  assert.equal(plan.purpose, 'ai')
  assert.equal(plan.agents.rule, 'owned_agents')
  assert.equal(plan.agents.count, 1, 'the agent pinned to the plan')

  const mailbox = byId.get(`mailbox:${h.ids.mailboxPersonal}`)!
  assert.equal(mailbox.serviceName, 'Other email provider')
  assert.deepEqual(mailbox.owner, {
    displayName: null,
    isViewer: true,
    kind: 'person',
    userId: h.ids.users.member,
  })
  assert.equal(mailbox.agents.canManage, true)
})

runDatabaseTest('a team’s and the organisation’s accounts are read by an owner or admin, by address', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  // A member of the team is still not a manager of company connections.
  h.as('member')
  assert.equal((await get(h, `/api/accounts?scope=team:${h.ids.team}`)).status, 403)
  assert.equal((await get(h, '/api/accounts?scope=organisation')).status, 403)

  h.as('admin')
  const team = await get(h, `/api/accounts?scope=team:${h.ids.team}`)
  assert.equal(team.status, 200)
  const teamAccounts = AccountListResponseSchema.parse(team.body.data).accounts
  const shared = teamAccounts.find((account) => account.id === `mailbox:${h.ids.mailboxShared}`)!
  assert.deepEqual(shared.owner, { kind: 'team', name: shared.owner.kind === 'team' ? shared.owner.name : '', teamId: h.ids.team })
  assert.equal(shared.status.word, 'needs_attention')
  assert.equal(shared.agents.count, 1)
  // The team's own cloud browser account — which the cloud browser list
  // never returned — is on its team's page.
  const browser = teamAccounts.find((account) => account.id === `browser:${h.ids.browserTeam}`)!
  assert.equal(browser.scope, 'team')
  assert.equal(browser.integration, 'cloud-browser')
  // Its key is the owner's to change, so an admin is offered no action.
  assert.deepEqual(browser.actions, [])

  const organisation = AccountListResponseSchema.parse(
    (await get(h, '/api/accounts?scope=organisation')).body.data,
  ).accounts
  assert.deepEqual(organisation.map((account) => account.id), [`browser:${h.ids.browserOrganisation}`])
  assert.equal(organisation[0]!.status.remedy, 'replace_key')

  h.as('owner')
  const owned = AccountListResponseSchema.parse(
    (await get(h, '/api/accounts?scope=organisation')).body.data,
  ).accounts
  assert.deepEqual(owned[0]!.actions, ['reconnect', 'disconnect'])

  // A team the address cannot name, or another organisation's team, is an
  // error — never a fall-back to the viewer's own team.
  assert.equal((await get(h, `/api/accounts?scope=team:${h.ids.foreignTeam}`)).status, 404)
  assert.equal((await get(h, '/api/accounts?scope=team:support')).status, 400)
  assert.equal((await get(h, '/api/accounts?scope=organization')).status, 400)
})

runDatabaseTest('one account, and what depends on it', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const plan = await get(h, `/api/accounts/ai-plan:${h.ids.plan}`)
  assert.equal(plan.status, 200)
  const detail = AccountDetailSchema.parse(plan.body.data)
  assert.deepEqual(detail.usedIn.agents, [{ id: h.ids.agentPrivate, name: 'Diary', reason: 'runs_on' }])

  // A shared mailbox is visible to its team's members, read-only, and its
  // dependents are named.
  const shared = AccountDetailSchema.parse((await get(h, `/api/accounts/mailbox:${h.ids.mailboxShared}`)).body.data)
  assert.equal(shared.account.agents.canManage, false)
  assert.deepEqual(shared.account.actions, [])
  assert.deepEqual(shared.usedIn.agents.map((agent) => agent.reason), ['may_use'])

  // Somebody else's account answers exactly as one that does not exist, and
  // so does the retired bare id and a store that does not exist.
  for (const url of [
    `/api/accounts/comms:${h.ids.commsOthers}`,
    `/api/accounts/${h.ids.comms}`,
    `/api/accounts/vault:${h.ids.comms}`,
  ]) {
    const refused = await get(h, url)
    assert.equal(refused.status, 404, url)
    assert.equal(refused.body.error?.code, 'ACCOUNT_NOT_FOUND')
  }

  // Not a team member and not a manager: the shared mailbox is not theirs to read.
  h.as('other')
  assert.equal((await get(h, `/api/accounts/mailbox:${h.ids.mailboxShared}`)).status, 404)
})

runDatabaseTest('agents with access: the mailbox’s own rows, both decisions side by side', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const read = await get(h, `/api/accounts/mailbox:${h.ids.mailboxPersonal}/agents`)
  assert.equal(read.status, 200)
  const grants = AccountAgentGrantsSchema.parse(read.body.data)
  assert.equal(grants.rule, 'listed')
  assert.equal(grants.canManage, true)
  assert.equal(grants.toolsLabel, 'Mailbox tools')
  // The member's own agents; another member's private one is never named.
  assert.deepEqual(grants.agents.map((agent) => agent.name), ['Diary', 'Scout'])
  const scout = grants.agents.find((agent) => agent.agentId === h.ids.agentShared)!
  assert.equal(scout.allowed, false)
  assert.equal(scout.tools, 'on')

  const allowed = await put(h, `/api/accounts/mailbox:${h.ids.mailboxPersonal}/agents/${h.ids.agentShared}`, {
    allowed: true,
  })
  assert.equal(allowed.status, 200)
  assert.equal((allowed.body.data as { agent: { allowed: boolean } }).agent.allowed, true)
  const row = await prisma.mailboxConnectionAgentAccess.findFirst({
    where: { agentId: h.ids.agentShared, connectionId: h.ids.mailboxPersonal },
  })
  assert.ok(row, 'the access row the worker reads was written')
  // The agent's own mailbox tools are the second decision, and untouched.
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: h.ids.agentShared } })
  assert.deepEqual(agent.toolPolicy, { mailbox_read: true })

  // A team member may read a shared mailbox's agents but not change them.
  const sharedRead = AccountAgentGrantsSchema.parse(
    (await get(h, `/api/accounts/mailbox:${h.ids.mailboxShared}/agents`)).body.data,
  )
  assert.equal(sharedRead.canManage, false)
  assert.ok(sharedRead.manageReason)
  const refused = await put(h, `/api/accounts/mailbox:${h.ids.mailboxShared}/agents/${h.ids.agentShared}`, {
    allowed: false,
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error?.code, 'NOT_PERMITTED')

  h.as('admin')
  const revoked = await put(h, `/api/accounts/mailbox:${h.ids.mailboxShared}/agents/${h.ids.agentShared}`, {
    allowed: false,
  })
  assert.equal(revoked.status, 200)
  assert.equal(
    await prisma.mailboxConnectionAgentAccess.count({ where: { connectionId: h.ids.mailboxShared } }),
    0,
  )
})

runDatabaseTest('every kind without a per-agent switch is refused, saying where its decision lives', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  for (const id of [`ai-plan:${h.ids.plan}`, `tickets:${h.ids.tickets}`, `comms:${h.ids.comms}`]) {
    const refused = await put(h, `/api/accounts/${id}/agents/${h.ids.agentShared}`, { allowed: true })
    assert.equal(refused.status, 409, id)
    assert.equal(refused.body.error?.code, 'ACCOUNT_NOT_GRANTABLE')
  }
  const planGrants = AccountAgentGrantsSchema.parse(
    (await get(h, `/api/accounts/ai-plan:${h.ids.plan}/agents`)).body.data,
  )
  assert.equal(planGrants.rule, 'owned_agents')
  assert.deepEqual(
    planGrants.agents.map((agent) => [agent.name, agent.allowed]),
    [['Diary', true], ['Scout', false]],
  )
  assert.equal((await put(h, `/api/accounts/${h.ids.comms}/agents/${h.ids.agentShared}`, { allowed: true })).status, 404)
  assert.equal(
    (await put(h, `/api/accounts/mailbox:${h.ids.mailboxPersonal}/agents/${h.ids.agentShared}`, { allowed: 'yes' })).status,
    400,
  )
})

runDatabaseTest('the same decisions from the agent’s side', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const mirror = AgentAccountGrantsSchema.parse(
    (await get(h, `/api/accounts/for-agent/${h.ids.agentShared}`)).body.data,
  )
  const rows = new Map(mirror.accounts.map((entry) => [entry.account.id, entry]))
  assert.equal(rows.get(`mailbox:${h.ids.mailboxShared}`)?.allowed, true)
  assert.equal(rows.get(`mailbox:${h.ids.mailboxShared}`)?.canManage, false)
  assert.equal(rows.get(`mailbox:${h.ids.mailboxPersonal}`)?.allowed, false)
  assert.equal(rows.get(`mailbox:${h.ids.mailboxPersonal}`)?.tools, 'on')

  // Another member's private agent is not the viewer's to inspect.
  assert.equal((await get(h, `/api/accounts/for-agent/${h.ids.agentOthers}`)).status, 404)
})
