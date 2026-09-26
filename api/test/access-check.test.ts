import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { ACCESS_CHECK_STEP_IDS, AccessCheckResultSchema, type AccessCheckResult } from '@nessie/schemas'

import { createAccountsHarness, type AccountsHarness } from './accounts-harness.js'

// Check access answers, in order and in words, each step the runtime takes
// for one agent, one account and one place it is asked from — composed from
// the runtime's own evaluators — with the one remedy the viewer may take for
// the first step that fails, and nothing about anybody else.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Reply = { data?: unknown; error?: { code: string } }

const check = async (h: AccountsHarness, accountId: string, agentId: string, context?: string) => {
  const query = new URLSearchParams({ agentId, ...(context ? { context } : {}) })
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/accounts/${accountId}/access-check?${query.toString()}`,
  })
  return { body: JSON.parse(response.body) as Reply, raw: response.body, status: response.statusCode }
}

const result = (reply: { body: Reply; status: number }): AccessCheckResult => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body))
  const parsed = AccessCheckResultSchema.parse(reply.body.data)
  assert.deepEqual(parsed.steps.map((step) => step.id), [...ACCESS_CHECK_STEP_IDS], 'every answer reads the same way')
  return parsed
}

const firstFailure = (answer: AccessCheckResult) => answer.steps.find((step) => step.outcome === 'fail')

runDatabaseTest('a mailbox: the access row, the agent’s own tools, the person asking, and every send approved', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const personal = `mailbox:${h.ids.mailboxPersonal}`
  const refused = result(await check(h, personal, h.ids.agentShared))
  assert.equal(refused.verdict, 'refused')
  assert.equal(firstFailure(refused)?.id, 'agent')
  assert.deepEqual(firstFailure(refused)?.remedy, {
    code: 'allow_agent',
    href: `/settings/accounts/${personal}`,
    label: 'Allow Scout on the mailbox',
  })
  assert.match(refused.summary, /^Scout cannot use this account when you ask it directly\./)

  await h.app.inject({
    method: 'PUT',
    payload: { allowed: true },
    url: `/api/accounts/${personal}/agents/${h.ids.agentShared}`,
  })
  const allowed = result(await check(h, personal, h.ids.agentShared))
  assert.equal(allowed.verdict, 'allowed_with_approval')
  const policy = allowed.steps.find((step) => step.id === 'policy')!
  assert.equal(policy.outcome, 'warn')
  assert.match(policy.reason.sentence, /Every message it sends waits for you to approve it\./)

  // The same agent with nobody asking never reaches a personal mailbox.
  const unattended = result(await check(h, personal, h.ids.agentShared, 'unattended'))
  assert.equal(firstFailure(unattended)?.id, 'context')
  assert.equal(firstFailure(unattended)?.reason.code, 'personal_needs_owner')

  // In a conversation the agent is not in, that is the first thing that fails.
  const room = result(await check(h, personal, h.ids.agentShared, `channel:${h.ids.channel}`))
  assert.equal(firstFailure(room)?.reason.code, 'agent_not_in_conversation')
  assert.equal(firstFailure(room)?.remedy?.code, 'place_agent')

  // An agent without its mailbox tools is refused there, and a member is
  // told who can turn them on rather than handed a page they cannot use.
  const diary = result(await check(h, personal, h.ids.agentPrivate))
  const tools = diary.steps.find((step) => step.id === 'tools')!
  assert.equal(tools.outcome, 'fail')
  assert.equal(tools.remedy?.code, 'ask_owner')
  assert.equal(tools.remedy?.href, null)
})

runDatabaseTest('a shared mailbox that stopped answers at the first step, for its team', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  // An admin sees an agent the way the agents list shows it: working in a
  // conversation they can open.
  await prisma.agentBinding.create({ data: { agentId: h.ids.agentShared, channelId: h.ids.channel } })
  h.as('admin')
  const answer = result(await check(h, `mailbox:${h.ids.mailboxShared}`, h.ids.agentShared))
  assert.equal(answer.verdict, 'refused')
  assert.equal(firstFailure(answer)?.id, 'account')
  assert.equal(firstFailure(answer)?.remedy?.href, `/admin/connections/mailbox:${h.ids.mailboxShared}`)
  // The steps after a failure that would only restate it say so.
  assert.equal(answer.steps.find((step) => step.id === 'context')?.outcome, 'skip')
})

runDatabaseTest('a Google account: what Google allows, the agent’s own tools, and the person asking', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const google = `comms:${h.ids.comms}`
  const without = result(await check(h, google, h.ids.agentShared))
  assert.equal(without.steps.find((step) => step.id === 'provider')?.outcome, 'pass')
  assert.equal(firstFailure(without)?.reason.code, 'google_tools_off')

  await prisma.agent.update({
    data: { toolPolicy: { gmail_search: true, mailbox_read: true } },
    where: { id: h.ids.agentShared },
  })
  const withTools = result(await check(h, google, h.ids.agentShared))
  // Reading only — Google granted no sending — so nothing waits for approval.
  assert.equal(withTools.verdict, 'allowed')
  assert.equal(withTools.steps.find((step) => step.id === 'context')?.reason.code, 'this_account')

  const unattended = result(await check(h, google, h.ids.agentShared, 'unattended'))
  assert.equal(firstFailure(unattended)?.reason.code, 'nobody_asking')

  // Nothing about the other member's Google account, or their private agent,
  // is anywhere in an answer about this one.
  const raw = (await check(h, google, h.ids.agentShared)).raw
  assert.doesNotMatch(raw, /other@example\.test/)
  assert.doesNotMatch(raw, /Secret/)
})

runDatabaseTest('an AI plan runs the agents its owner pinned to it, whoever asks', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const plan = `ai-plan:${h.ids.plan}`
  const pinned = result(await check(h, plan, h.ids.agentPrivate, 'unattended'))
  assert.equal(pinned.verdict, 'allowed')
  const other = result(await check(h, plan, h.ids.agentShared))
  assert.equal(firstFailure(other)?.reason.code, 'not_pinned')
  assert.deepEqual(firstFailure(other)?.remedy, {
    code: 'finish_setup',
    href: `/admin/agents/${h.ids.agentShared}`,
    label: 'Choose this plan for Scout',
  })
})

runDatabaseTest('what the viewer cannot see is not found, and an account no agent uses has nothing to check', async (t) => {
  const prisma = new PrismaClient()
  const h = await createAccountsHarness(prisma)
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })

  h.as('member')
  const cases: [string, string, string | undefined, number, string][] = [
    [`comms:${h.ids.commsOthers}`, h.ids.agentShared, undefined, 404, 'ACCOUNT_NOT_FOUND'],
    [`comms:${h.ids.comms}`, h.ids.agentOthers, undefined, 404, 'AGENT_NOT_FOUND'],
    [`comms:${h.ids.comms}`, h.ids.agentShared, `channel:${randomUUID()}`, 404, 'CONTEXT_NOT_FOUND'],
    [`comms:${h.ids.comms}`, h.ids.agentShared, 'project', 400, 'VALIDATION_ERROR'],
    [`tickets:${h.ids.tickets}`, h.ids.agentShared, undefined, 409, 'ACCESS_CHECK_NOT_APPLICABLE'],
  ]
  for (const [accountId, agentId, context, status, code] of cases) {
    const reply = await check(h, accountId, agentId, context)
    assert.equal(reply.status, status, `${accountId} ${context ?? ''}`)
    assert.equal(reply.body.error?.code, code)
  }
})
