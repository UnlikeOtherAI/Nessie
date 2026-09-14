import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

import type { ChannelRecord, UserRecord } from '../src/lib/api-client'
import {
  channelMayAskToInvite,
  findMentionedNonMemberIds,
  mentionableUsers,
} from '../src/components/features/channels/mention-invite.js'
import {
  MentionInviteDialogBody,
  mentionInviteCopy,
} from '../src/components/features/channels/MentionInviteDialog.js'
import type { MentionInviteController } from '../src/components/features/channels/useMentionInviteGate.js'
import { buildUserMentionEntities } from '../src/pages/channels/useChannelMentions.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const CHANNEL = '00000000-0000-4000-8000-00000000c001'

const person = (
  id: string,
  displayName: string,
  over: Partial<UserRecord> = {},
): UserRecord => ({
  channelIds: [],
  createdAt: '2026-09-14T00:00:00.000Z',
  displayName,
  email: `${id}@example.com`,
  id,
  role: 'member',
  updatedAt: '2026-09-14T00:00:00.000Z',
  ...over,
})

const me = person('me', 'Ada Author', { channelIds: [CHANNEL] })
const member = person('member', 'Mia Member', { channelIds: [CHANNEL] })
const outsider = person('outsider', 'Otto Outsider')
const gone = person('gone', 'Dora Gone', { deactivatedAt: '2026-09-01T00:00:00.000Z' })
const directory = [me, member, outsider, gone]

test('every active person in the organisation is a mention candidate, not only the room', () => {
  assert.deepEqual(
    buildUserMentionEntities(mentionableUsers(directory)).map((entity) => entity.id),
    ['me', 'member', 'outsider'],
    'a non-member is offered; a deactivated member never is',
  )
  // The page hands the composer the whole directory, not the room's participants.
  const participants = readSource('../src/pages/channels/useChannelParticipants.ts')
  assert.match(participants, /mentionUsers = useMemo\(\(\) => mentionableUsers\(users\)/)
  assert.doesNotMatch(
    readSource('../src/pages/channels/useChannelMentions.tsx'),
    /channelUsers/,
    'mention candidates are no longer narrowed to channel participants',
  )
})

test('the draft names the non-members the server will be asked about', () => {
  const input = { channelId: CHANNEL, currentUserId: me.id }
  assert.deepEqual(
    findMentionedNonMemberIds('@Otto Outsider and @Mia Member, look', directory, input),
    ['outsider'],
    'a known member needs no question',
  )
  assert.deepEqual(findMentionedNonMemberIds('@Ada Author @Dora Gone hi', directory, input), [])
  assert.deepEqual(findMentionedNonMemberIds('otto outsider, no at sign', directory, input), [])
  assert.deepEqual(findMentionedNonMemberIds('email@Otto Outsiderx', directory, input), [])
})

test('only a standard channel can ask; a DM and a system conversation keep today\'s behaviour', () => {
  const channel = { id: CHANNEL, label: 'finance', type: 'standard' } as ChannelRecord
  assert.equal(channelMayAskToInvite(channel), true)
  assert.equal(channelMayAskToInvite({ ...channel, type: 'dm' }), false)
  assert.equal(
    channelMayAskToInvite({ ...channel, systemChannelType: 'personal_assistant' } as ChannelRecord),
    false,
  )
  assert.equal(channelMayAskToInvite(null), false)
})

const controller = (over: Partial<MentionInviteController> = {}): MentionInviteController => ({
  error: null,
  onCancel: () => undefined,
  onInviteAndSend: () => undefined,
  onSendWithoutInviting: () => undefined,
  pending: false,
  prompt: null,
  ...over,
})

test('the question says who cannot see the room and what sending without inviting means', () => {
  const prompt = {
    agentMentions: [],
    canInvite: true,
    channelLabel: 'finance',
    outsiders: [outsider],
    text: '@Otto Outsider hi',
  }
  const copy = mentionInviteCopy(prompt)
  assert.equal(copy.title, 'Invite Otto Outsider to #finance?')
  assert.equal(copy.refusal, null)

  const document = new JSDOM(
    `<body>${renderToStaticMarkup(createElement(MentionInviteDialogBody, { controller: controller(), prompt }))}</body>`,
  ).window.document
  assert.match(document.body.textContent ?? '', /Otto Outsider is not in #finance and can't see it/)
  assert.match(document.body.textContent ?? '', /won't be notified and won't see the message/)

  const refused = new JSDOM(
    `<body>${renderToStaticMarkup(createElement(MentionInviteDialogBody, {
      controller: controller({ error: 'Could not add Otto Outsider.' }),
      prompt: { ...prompt, canInvite: false, outsiders: [outsider, member] },
    }))}</body>`,
  ).window.document
  assert.ok(refused.querySelector('[data-testid="mention-invite-refusal"]'))
  assert.equal(refused.querySelector('[role="alert"]')?.textContent, 'Could not add Otto Outsider.')
  assert.match(refused.body.textContent ?? '', /Otto Outsider and Mia Member are not in #finance/)
})

test('every composer renders the question it can hold a draft for', () => {
  const composer = readSource('../src/components/features/channels/ChannelComposer.tsx')
  assert.match(composer, /mentionInvite: MentionInviteController\n/, 'the prop is required')
  assert.match(composer, /<MentionInviteDialog controller=\{mentionInvite\} \/>/)
})
