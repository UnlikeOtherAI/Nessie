import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideAgentEngagement,
  selectFollowingAgentIds,
  type OrchestratorAgent,
} from '../src/orchestrator.js'
import type { ModelClient, ModelMessage } from '../src/model.js'
import { ProviderInvocationError } from '../src/inference/types.js'

// decideAgentEngagement only ever calls `modelClient.chat`. Build a stub that
// captures the prompt it receives and returns a canned reply, so the tests can
// assert both the decision and what the model was (or was not) asked to decide.
const makeModel = (
  reply: string,
  capture?: (messages: ModelMessage[]) => void,
): ModelClient => {
  const chat: ModelClient['chat'] = async (messages) => {
    capture?.(messages)
    return reply
  }
  return { chat } as unknown as ModelClient
}

// A model that must never be consulted — any call is a test failure.
const forbiddenModel = (): ModelClient =>
  ({
    chat: async () => {
      throw new Error('model must not be called')
    },
  }) as unknown as ModelClient

const agent = (id: string, name: string): OrchestratorAgent => ({
  id,
  name,
  role: 'assistant',
  systemPrompt: null,
})

const aria = agent('11111111-1111-1111-1111-111111111111', 'Aria')
const beck = agent('22222222-2222-2222-2222-222222222222', 'Beck')

const systemPromptOf = (messages: ModelMessage[]): string =>
  messages.find((m) => m.role === 'system')?.content ?? ''

// The following marker appears verbatim inside rule 3's text, so "is any agent
// annotated?" must key off the agent-description form, which ends in a colon
// (`[already participating in this thread]: <summary>`) rather than the rule's
// prose. Positive per-agent checks use `"<Name>".*<marker>` on the same line.
const ANNOTATION = /\[already participating in this thread\]:/

// ── selectFollowingAgentIds predicate ─────────────────────────────────────

test('selectFollowingAgentIds returns candidates that have authored', () => {
  assert.deepEqual(
    selectFollowingAgentIds([aria.id, beck.id], [aria.id]),
    [aria.id],
  )
})

test('selectFollowingAgentIds ignores authored ids outside the candidate set', () => {
  assert.deepEqual(
    selectFollowingAgentIds([aria.id], [beck.id]),
    [],
  )
})

test('selectFollowingAgentIds dedupes candidate ids', () => {
  assert.deepEqual(
    selectFollowingAgentIds([aria.id, aria.id], [aria.id]),
    [aria.id],
  )
})

// ── mention path unchanged ─────────────────────────────────────────────────

test('an @mention replies to the named agent without consulting the model', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: 'hey @Aria can you take this',
    recentMessages: [],
    triggerIsHuman: true,
  })
  // Being addressed is a structural fact, so placement is stamped, not judged.
  assert.deepEqual(decisions, [
    { action: 'reply', agentId: aria.id, replyPlacement: 'thread' },
  ])
})

test('multiple @mentions reply for each named agent (mention behavior intact)', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: '@Aria @Beck please both weigh in',
    recentMessages: [],
    triggerIsHuman: true,
    // Follow state must not alter the mention fast path.
    followingAgentIds: [aria.id],
  })
  assert.deepEqual(decisions, [
    { action: 'reply', agentId: aria.id, replyPlacement: 'thread' },
    { action: 'reply', agentId: beck.id, replyPlacement: 'thread' },
  ])
})

test('an @mention in another language is still a structurally threaded reply', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: 'ahoj @Aria, můžeš se na to prosím kouknout?',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [
    { action: 'reply', agentId: aria.id, replyPlacement: 'thread' },
  ])
})

test('a PA presence mention uses its stored ids and never parses its display name', async () => {
  const principalUserId = '33333333-3333-3333-3333-333333333333'
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [{ ...aria, name: 'Personal Assistant', principalUserId }],
    agentMentions: [{ agentId: aria.id, principalUserId, type: 'agent' }],
    // This intentionally has no recognizable agent name. The structured
    // entity, not the canonical public token, is the address.
    content: '@A person with the same name – PA can you take this?',
    recentMessages: [],
    triggerIsHuman: true,
  })

  assert.deepEqual(decisions, [{
    action: 'reply',
    agentId: aria.id,
    principalUserId,
    replyPlacement: 'thread',
  }])
})

test('a structured mention addresses only the selected duplicate-named agent', async () => {
  const duplicateAria = { ...aria, name: 'Web summary' }
  const duplicateBeck = { ...beck, name: 'Web summary' }
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [duplicateAria, duplicateBeck],
    agentMentions: [{ agentId: duplicateAria.id, type: 'agent' }],
    content: '@Web summary are you there?',
    recentMessages: [],
    triggerIsHuman: true,
  })

  assert.deepEqual(decisions, [{
    action: 'reply',
    agentId: duplicateAria.id,
    replyPlacement: 'thread',
  }])
})

test('plain @PA never addresses a presence', async () => {
  const principalUserId = '33333333-3333-3333-3333-333333333333'
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [{ ...aria, name: 'PA', principalUserId }],
    content: '@PA can you take this?',
    recentMessages: [],
    triggerIsHuman: true,
  })

  assert.deepEqual(decisions, [])
})

test('an @mention of no known agent stays silent (user-to-user)', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: 'hey @Charlie are you around?',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [])
})

// ── Anti-loop invariant (1)+(2): only humans trigger, no ping-pong ─────────

test('a non-human trigger engages no agent and never calls the model', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: 'Beck: here is the result you asked for',
    recentMessages: [],
    triggerIsHuman: false,
    // Even a following agent must not be re-triggered by another agent's post.
    followingAgentIds: [aria.id],
  })
  assert.deepEqual(decisions, [])
})

test('a non-human trigger stays silent even with an @mention of an agent', async () => {
  const decisions = await decideAgentEngagement(forbiddenModel(), {
    agents: [aria, beck],
    content: '@Aria what do you think?',
    recentMessages: [],
    triggerIsHuman: false,
  })
  assert.deepEqual(decisions, [])
})

test('the model-judged router rethrows only Ledger credit exhaustion', async () => {
  const refusal = new ProviderInvocationError(
    'openai-compatible chat request failed with HTTP 402',
    {
      finishReason: 'error',
      invocationId: 'invocation-402',
      latencyMs: 1,
      model: 'ledger-model',
      operationType: 'chat',
      provider: 'openai-compatible',
      requestId: 'request-402',
      usage: {},
    },
    undefined,
    { creditRefusal: 'ledger', providerCode: 'budget_exceeded', statusCode: 402 },
  )
  const model = {
    chat: async () => {
      throw refusal
    },
  } as unknown as ModelClient

  await assert.rejects(
    decideAgentEngagement(model, {
      agents: [aria],
      content: 'can you take a look?',
      recentMessages: [],
      triggerIsHuman: true,
    }),
    (error) => error === refusal,
  )
})

test('a generic router failure remains fail-open', async () => {
  const model = {
    chat: async () => {
      throw new Error('provider unavailable')
    },
  } as unknown as ModelClient

  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: 'could you take a look?',
    recentMessages: [],
    triggerIsHuman: true,
  })

  assert.deepEqual(decisions, [])
})

// ── Thread-following feeds the decision ────────────────────────────────────

test('a following agent is annotated so the model keeps it engaged', async () => {
  let captured = ''
  const model = makeModel(
    JSON.stringify({ action: 'reply', agentId: aria.id }),
    (messages) => {
      captured = systemPromptOf(messages)
    },
  )
  const decisions = await decideAgentEngagement(model, {
    agents: [aria, beck],
    content: 'actually make it blue instead',
    recentMessages: [{ role: 'assistant', content: 'Done, it is green now', agentName: 'Aria' }],
    triggerIsHuman: true,
    followingAgentIds: [aria.id],
  })
  // Aria (following) is flagged; Beck (not following) is not.
  assert.match(captured, /"Aria".*already participating in this thread/)
  assert.doesNotMatch(captured, /"Beck".*already participating in this thread/)
  assert.deepEqual(decisions, [{ action: 'reply', agentId: aria.id }])
})

test('following never forces a reply — the model may still decline', async () => {
  const model = makeModel(JSON.stringify({ action: 'none' }))
  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: 'brb grabbing coffee',
    recentMessages: [],
    triggerIsHuman: true,
    followingAgentIds: [aria.id],
  })
  assert.deepEqual(decisions, [])
})

// ── Anti-loop invariant (3): no thundering herd ────────────────────────────

test('two following agents still yield at most one non-mention reply', async () => {
  let captured = ''
  const model = makeModel(
    JSON.stringify({ action: 'reply', agentId: beck.id }),
    (messages) => {
      captured = systemPromptOf(messages)
    },
  )
  const decisions = await decideAgentEngagement(model, {
    agents: [aria, beck],
    content: 'that plan works, ship it',
    recentMessages: [],
    triggerIsHuman: true,
    followingAgentIds: [aria.id, beck.id],
  })
  // Both are marked as participating, but the decision selects exactly one.
  assert.match(captured, /"Aria".*already participating in this thread/)
  assert.match(captured, /"Beck".*already participating in this thread/)
  assert.equal(decisions.length, 1)
  assert.deepEqual(decisions, [{ action: 'reply', agentId: beck.id }])
})

// ── PA DM path unchanged (no follow set supplied) ──────────────────────────

test('with no follow set the prompt carries no following annotation', async () => {
  let captured = ''
  const model = makeModel(JSON.stringify({ action: 'none' }), (messages) => {
    captured = systemPromptOf(messages)
  })
  await decideAgentEngagement(model, {
    agents: [aria],
    content: 'what is the status?',
    recentMessages: [],
    triggerIsHuman: true,
    // PA DMs pass no followingAgentIds; behavior must match the pre-feature path.
    followingAgentIds: [],
  })
  assert.doesNotMatch(captured, ANNOTATION)
})

test('a follow id absent from the agent list is not annotated', async () => {
  let captured = ''
  const model = makeModel(JSON.stringify({ action: 'none' }), (messages) => {
    captured = systemPromptOf(messages)
  })
  await decideAgentEngagement(model, {
    agents: [aria],
    content: 'ping',
    recentMessages: [],
    triggerIsHuman: true,
    // Beck follows the thread but is not a candidate here — must be ignored.
    followingAgentIds: [beck.id],
  })
  assert.doesNotMatch(captured, ANNOTATION)
})

// ── Reply placement is judged by the model, never by inspecting the text ───
//
// Placement fixtures deliberately use non-English, slang, and misspelled input:
// the decision must ride entirely on the model's JSON, so the same content
// yields whatever the model said and nothing in the code may branch on wording.

test('the prompt asks for a placement and explains what it means, without examples', async () => {
  let captured = ''
  const model = makeModel(JSON.stringify({ action: 'none' }), (messages) => {
    captured = systemPromptOf(messages)
  })
  await decideAgentEngagement(model, {
    agents: [aria],
    content: 'kannst du das bitte nochmal prüfen',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.match(captured, /replyPlacement/)
  assert.match(captured, /"thread"/)
  assert.match(captured, /"channel"/)
})

test('a "channel" judgement is carried onto the decision (slang input)', async () => {
  const model = makeModel(
    JSON.stringify({ action: 'reply', agentId: aria.id, replyPlacement: 'channel' }),
  )
  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: 'yo team heads up the deploy is prob gonna slip lol',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [
    { action: 'reply', agentId: aria.id, replyPlacement: 'channel' },
  ])
})

test('a "thread" judgement is carried onto the decision (misspelled input)', async () => {
  const model = makeModel(
    JSON.stringify({ action: 'reply', agentId: aria.id, replyPlacement: 'thread' }),
  )
  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: 'coudl u recheck teh deploymnt loggs plz',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [
    { action: 'reply', agentId: aria.id, replyPlacement: 'thread' },
  ])
})

test('an unparseable placement is dropped, leaving the default (non-English input)', async () => {
  for (const replyPlacement of ['Thread', 'inline', '', 'канал', 42, null, {}, ['thread']]) {
    const model = makeModel(
      JSON.stringify({ action: 'reply', agentId: aria.id, replyPlacement }),
    )
    const decisions = await decideAgentEngagement(model, {
      agents: [aria],
      content: 'сможешь глянуть логи деплоя?',
      recentMessages: [],
      triggerIsHuman: true,
    })
    assert.deepEqual(
      decisions,
      [{ action: 'reply', agentId: aria.id }],
      `placement ${JSON.stringify(replyPlacement)} must be ignored`,
    )
  }
})

test('a decision with no placement field keeps the historical default', async () => {
  const model = makeModel(JSON.stringify({ action: 'reply', agentId: aria.id }))
  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: '¿puedes revisar el despliegue?',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [{ action: 'reply', agentId: aria.id }])
})

test('placement never leaks onto an acknowledge decision', async () => {
  const model = makeModel(
    JSON.stringify({
      action: 'acknowledge',
      agentId: aria.id,
      emoji: '👍',
      replyPlacement: 'channel',
    }),
  )
  const decisions = await decideAgentEngagement(model, {
    agents: [aria],
    content: 'díky moc',
    recentMessages: [],
    triggerIsHuman: true,
  })
  assert.deepEqual(decisions, [
    { action: 'acknowledge', agentId: aria.id, emoji: '👍' },
  ])
})
