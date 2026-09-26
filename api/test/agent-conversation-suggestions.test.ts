import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import type { ModelClient, ModelMessage } from '@nessie/runtime'
import {
  loadAgentConversationSuggestions,
  SUGGESTION_COOLDOWN_MS,
} from '../src/services/agent-conversation-suggestions.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip
const questions = ['Jak připravíme další verzi?', 'Co zbývá ověřit před vydáním?', 'Který krok mám udělat dnes?']

databaseTest('agent home suggestions: durable cadence, concurrent claims and live source access', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `suggestions ${suffix}` } })
  const users: string[] = []
  try {
    const project = await prisma.project.create({ data: { name: 'Suggestions', organizationId: org.id } })
    const team = await prisma.team.create({ data: { name: 'Suggestions', projectId: project.id } })
    for (const label of ['owner', 'other']) {
      const user = await prisma.user.create({ data: { displayName: label, email: `${label}-${suffix}@example.test` } })
      users.push(user.id)
      await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'member' } })
    }
    const userId = users[0]!
    const agent = await prisma.agent.create({ data: {
      name: 'Assistant', organizationId: org.id, projectId: project.id, teamId: team.id,
    } })
    const makeHome = async (owner: string) => {
      const channel = await prisma.channel.create({ data: {
        organizationId: org.id, projectId: project.id, teamId: team.id,
        label: 'Assistant', type: 'dm', visibility: 'private', dmKey: `suggestions:${owner}`,
        members: { create: { userId: owner } }, agentBindings: { create: { agentId: agent.id } },
      } })
      const thread = await prisma.thread.create({ data: { channelId: channel.id, agentId: agent.id } })
      return { channel, thread }
    }
    const home = await makeHome(userId)
    const other = await makeHome(users[1]!)
    const input = {
      agentId: agent.id, channelId: home.channel.id, organizationId: org.id, userId,
      usage: { organizationId: org.id, actorId: userId },
    }
    let now = new Date('2026-09-26T00:00:00Z')
    let calls = 0
    let output: unknown = { questions }
    let afterInference: (() => Promise<void>) | undefined
    const prompts: ModelMessage[][] = []
    const modelClient = { chatJson: async (messages: ModelMessage[]) => {
      calls += 1
      prompts.push(messages)
      if (afterInference) await afterInference()
      return output
    } } as unknown as ModelClient
    const load = () => loadAgentConversationSuggestions({ prisma, modelClient, now: () => now }, input)
    const advance = () => { now = new Date(now.getTime() + SUGGESTION_COOLDOWN_MS) }
    assert.deepEqual((await load())?.questions, [], 'empty history uses generic prompts without inference')
    assert.equal(calls, 0)
    const message = await prisma.message.create({ data: {
      threadId: home.thread.id, userId, role: 'user', content: 'pls pomoz mi s přípravou další verze, nwm co dál',
    } })
    await prisma.message.createMany({ data: [
      { threadId: other.thread.id, userId: users[1], role: 'user', content: 'OTHER_PERSON_SECRET' },
      { threadId: home.thread.id, role: 'system', content: 'HIDDEN_TRIGGER' },
      { threadId: home.thread.id, role: 'assistant', content: 'DELETED_REPLY', deletedAt: now },
    ] })
    const restricted = await prisma.message.create({ data: {
      threadId: home.thread.id, agentId: agent.id, role: 'assistant', content: 'RESTRICTED_REPLY',
      basisScopes: { create: { organizationId: org.id, scopeType: 'user', scopeId: userId } },
    } })
    await Promise.all(Array.from({ length: 6 }, load))
    assert.equal(calls, 1, 'simultaneous tabs/replicas claim once')
    assert.deepEqual((await load())?.questions, questions)
    const prompt = JSON.stringify(prompts[0])
    assert.ok(prompt.includes(message.content), 'non-English informal history reaches the model unchanged')
    for (const secret of ['OTHER_PERSON_SECRET', 'HIDDEN_TRIGGER', 'DELETED_REPLY', restricted.content]) {
      assert.ok(!prompt.includes(secret), `${secret} never reaches inference`)
    }
    advance()
    await load()
    assert.equal(calls, 1, 'elapsed time without activity never regenerates')
    await prisma.thread.create({ data: { channelId: home.channel.id, agentId: agent.id } })
    const activeRun = await prisma.run.create({ data: {
      agentId: agent.id, threadId: home.thread.id, status: 'running',
    } })
    await load()
    assert.equal(calls, 1, 'ongoing conversation waits for a terminal run')
    await prisma.run.update({ where: { id: activeRun.id }, data: { status: 'waiting_input' } })
    await load()
    assert.equal(calls, 2, 'new conversation refreshes; an older run waiting for input does not block it')
    await prisma.run.update({ where: { id: activeRun.id }, data: { status: 'completed', finishedAt: now } })
    await prisma.message.create({ data: {
      threadId: home.thread.id, agentId: agent.id, role: 'assistant', content: 'Here is the completed next-step plan.',
    } })
    await load()
    assert.equal(calls, 2, 'completion during cooldown keeps cached questions')
    now = new Date(now.getTime() + 59 * 60 * 1000 + 59_999)
    assert.deepEqual((await load())?.questions, questions)
    assert.equal(calls, 2, 'changed history stays cached until one full hour has passed')
    now = new Date(now.getTime() + 1)
    await load()
    assert.equal(calls, 3, 'changed history regenerates exactly one hour after the previous attempt')

    await prisma.message.update({ where: { id: message.id }, data: { content: 'Edited request' } })
    assert.deepEqual((await load())?.questions, [], 'edited source invalidates derived text during cooldown')
    assert.equal(calls, 3)
    advance()
    await load()
    assert.equal(calls, 4)
    await prisma.messageBasisScope.create({ data: {
      messageId: message.id, organizationId: org.id, scopeType: 'user', scopeId: userId,
    } })
    assert.deepEqual((await load())?.questions, [], 'new disclosure scope hides cached text immediately')
    await prisma.messageBasisScope.deleteMany({ where: { messageId: message.id } })
    assert.deepEqual((await load())?.questions, questions)
    await prisma.channelMember.create({ data: { channelId: home.channel.id, userId: users[1]! } })
    assert.equal(await load(), null, 'adding another human invalidates this private home')
    await prisma.channelMember.deleteMany({ where: { channelId: home.channel.id, userId: users[1]! } })
    assert.equal(await loadAgentConversationSuggestions({ prisma, modelClient }, { ...input, userId: users[1]! }), null)
    assert.equal(await loadAgentConversationSuggestions(
      { prisma, modelClient }, { ...input, organizationId: randomUUID() },
    ), null)

    // A malformed result consumes its window but never replaces valid questions.
    advance()
    await prisma.thread.create({ data: { channelId: home.channel.id, agentId: agent.id } })
    output = { questions: ['duplicate', 'duplicate', 'duplicate'] }
    assert.deepEqual((await load())?.questions, questions)
    const failedCalls = calls
    await load()
    assert.equal(calls, failedCalls, 'bad output does not create a retry storm')
    advance()
    output = { questions }
    afterInference = async () => {
      await prisma.message.update({ where: { id: message.id }, data: { deletedAt: now } })
    }
    assert.deepEqual((await load())?.questions, [], 'revocation during inference cannot publish stale source text')
    afterInference = undefined
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId } }, data: { deactivatedAt: now },
    })
    assert.equal(await load(), null, 'deactivated membership cannot read cache')
  } finally {
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.$disconnect()
  }
})
