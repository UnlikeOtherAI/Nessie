import assert from 'node:assert/strict'
import test from 'node:test'

import { publishCallStartedRealtime } from '../src/index.js'

const ids = {
  caller: '00000000-0000-4000-8000-000000000001',
  call: '00000000-0000-4000-8000-000000000002',
  channel: '00000000-0000-4000-8000-000000000003',
  inviteeA: '00000000-0000-4000-8000-000000000004',
  inviteeB: '00000000-0000-4000-8000-000000000005',
  organization: '00000000-0000-4000-8000-000000000006',
}

test('a call ring publishes one banner event and one separate user event per invitee', async () => {
  const publications: Array<{ scopes: unknown[]; event: string }> = []
  const prisma = {
    call: {
      findUnique: async () => ({
        channel: { id: ids.channel, label: 'General', organizationId: ids.organization },
        id: ids.call,
        invites: [
          { state: 'ringing', userId: ids.inviteeA },
          { state: 'ringing', userId: ids.inviteeB },
        ],
        meetingUri: 'https://meet.example.test/abc-defg-hij',
        revision: 0,
        ringExpiresAt: new Date('2026-09-01T10:00:00.000Z'),
        startedBy: { avatarUrl: null, displayName: 'Caller', id: ids.caller },
        status: 'ringing',
      }),
    },
  }
  const transport = {
    publishWs: async (scopes: unknown[], message: { event: string }) => {
      publications.push({ scopes, event: message.event })
    },
  }

  await publishCallStartedRealtime(prisma as never, transport as never, ids.call)

  assert.equal(publications.length, 3)
  assert.deepEqual(publications[0], {
    scopes: [{ kind: 'channel', channelId: ids.channel }],
    event: 'call.updated',
  })
  assert.deepEqual(publications.slice(1).map((publication) => publication.scopes), [
    [{ kind: 'user', organizationId: ids.organization, userId: ids.inviteeA }],
    [{ kind: 'user', organizationId: ids.organization, userId: ids.inviteeB }],
  ])
  assert.deepEqual(publications.slice(1).map((publication) => publication.event), [
    'call.incoming',
    'call.incoming',
  ])
})
