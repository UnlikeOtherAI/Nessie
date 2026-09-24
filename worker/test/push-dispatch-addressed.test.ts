import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePushDispatch } from '../src/control/push-dispatch.js'
import {
  ENCRYPTION_KEY_RING,
  apnsCred,
  apnsSecret,
  makeFakePrisma,
  member,
  payload,
  recordingSenders,
} from './push-dispatch-test-support.js'

/**
 * A push addressed to named people rather than a channel's members: a
 * DeepWater result or notice naming its requester (`recipientUserIds`, framed
 * as a mention). It rings only the people it addresses, and a notice whose
 * content is withheld keeps its mention framing and says what kind of news it
 * is in its own words.
 */

// A server message addressed to one person (a DeepWater result naming its
// requester) rings them in an open channel they read without joining, framed
// as a mention, and never rings anybody it does not address.
for (const visibility of ['public', 'private'] as const) {
  const verb = visibility === 'public' ? 'is' : 'is not'
  test(`an addressed, mentioned non-member ${verb} rung in a ${visibility} channel, and nobody else`, async () => {
    const state = {
      creds: [apnsCred()],
      members: [member('u2')],
      users: [
        { id: 'u2', preferences: null },
        { id: 'u3', preferences: null },
      ],
      tokens: [
        { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' as const },
        { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' as const },
      ],
      secrets: [apnsSecret()],
      channel: { label: 'Research', systemChannelType: null, type: 'standard', visibility },
      deleted: [],
    } as FakeState
    const prisma = makeFakePrisma(state)
    const lookedUp: unknown[] = []
    ;(prisma.organizationMember as unknown as { findMany: unknown }).findMany = async (
      args: { where: { userId: { in: string[] } } },
    ) => {
      lookedUp.push(args.where.userId.in)
      return args.where.userId.in.map((userId) => ({ userId }))
    }
    const { senders, apnsCalls, apnsPayloads } = recordingSenders()
    await handlePushDispatch(
      { prisma, encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
      payload({
        authorName: 'DeepWater',
        authorUserId: undefined,
        mentionUserIds: ['u3', 'u9'],
        recipientUserIds: ['u3'],
      }),
    )

    const byToken = new Map(apnsCalls.map((call, index) => [call.token, apnsPayloads[index]]))
    assert.equal(byToken.has('tok-u2'), false, 'a member it does not address is never rung')
    if (visibility === 'public') {
      assert.deepEqual(lookedUp, [['u3']], 'only addressed people are ever candidates')
      assert.match(byToken.get('tok-u3')?.subtitle ?? '', /mentioned you/)
      assert.equal(byToken.get('tok-u3')?.title, 'DeepWater')
    } else {
      assert.equal(byToken.has('tok-u3'), false)
      assert.deepEqual(lookedUp, [], 'a private channel never widens its recipients')
    }
  })
}

// A notice drawn on sources the room does not imply is sent generic: its
// words never reach the lock screen, but it is still a mention of the person
// it addresses, with the mention preference and DeepWater's own wording.
const restrictedNotice = () => payload({
  authorName: 'DeepWater',
  authorUserId: undefined,
  contentSnippet: 'Your DeepWater research “Private acquisition plan” has finished.',
  contentVisibility: 'generic',
  genericBody: 'Your DeepWater research has finished.',
  mentionUserIds: ['requester'],
  recipientUserIds: ['requester'],
})

const restrictedState = (preferences: unknown) => ({
  channel: { label: 'Deals' },
  creds: [apnsCred()],
  deleted: [],
  members: [member('requester')],
  message: {
    agent: null,
    agentId: null,
    basisScopes: [{ scopeId: 'channel-1', scopeType: 'channel' }],
    user: null,
  },
  secrets: [apnsSecret()],
  tokens: [{ id: 'requester-token', userId: 'requester', token: 'tok-requester', platform: 'ios' as const }],
  users: [{ id: 'requester', preferences }],
}) as FakeState

test('a restricted DeepWater notice is a mention of its requester, in its own words', async () => {
  const { senders, apnsCalls, apnsPayloads } = recordingSenders()
  await handlePushDispatch(
    { prisma: makeFakePrisma(restrictedState(null)), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    restrictedNotice(),
  )
  assert.deepEqual(apnsCalls.map((call) => call.token), ['tok-requester'])
  assert.equal(apnsPayloads[0]?.title, 'DeepWater')
  assert.equal(apnsPayloads[0]?.subtitle, 'mentioned you in # Deals')
  assert.equal(apnsPayloads[0]?.body, 'Your DeepWater research has finished.')
  assert.doesNotMatch(JSON.stringify(apnsPayloads), /Private acquisition plan/)
})

test('a restricted DeepWater notice follows the mention preference, not the message one', async () => {
  const ring = async (preferences: unknown) => {
    const { senders, apnsCalls } = recordingSenders()
    await handlePushDispatch(
      { prisma: makeFakePrisma(restrictedState(preferences)), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
      restrictedNotice(),
    )
    return apnsCalls.length
  }
  assert.equal(await ring({ pushMessages: false }), 1, 'channel messages off still rings a mention')
  assert.equal(await ring({ pushMentions: false }), 0, 'mentions off keeps it quiet')
})

test('an agent reply withheld from the lock screen keeps the agent-reply wording', async () => {
  const { senders, apnsPayloads } = recordingSenders()
  const state = restrictedState(null)
  state.message = { agent: { name: 'Smith' }, agentId: 'agent-1', basisScopes: [{ scopeId: 'channel-1', scopeType: 'channel' }], user: null }
  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({
      authorUserId: undefined,
      contentVisibility: 'generic',
      mentionUserIds: [],
      recipientUserIds: ['requester'],
    }),
  )
  assert.equal(apnsPayloads[0]?.body, 'An agent reply is ready.')
  assert.equal(apnsPayloads[0]?.subtitle, '# Deals')
})
