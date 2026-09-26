import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { getChannelIfMember } from '@nessie/team-admin'

test('PA placement sees a joined shared channel as non-system', async () => {
  const prisma = {
    channel: {
      findUnique: async () => ({
        deletedAt: null,
        members: [{ id: 'membership' }],
        organizationId: 'organization',
        systemChannelType: null,
        type: 'standard',
        visibility: 'public',
      }),
    },
  } as unknown as PrismaClient

  const channel = await getChannelIfMember(prisma, 'member', 'organization', 'shared-channel')
  assert.ok(channel)
  assert.equal(channel.systemChannelType, null)
})
