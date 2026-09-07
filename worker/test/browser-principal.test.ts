import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveBrowserPrincipal } from '../src/run/browser-cloud/browser-principal.js'

const principal = async (systemManaged: boolean, runPrincipal: string | null) =>
  resolveBrowserPrincipal({
    agentId: 'agent-1',
    agentIdentity: { ownerUserId: 'owner-1', visibility: 'private' },
    channel: { id: 'channel-1', organizationId: 'org-1' },
    prisma: {
      agent: { findFirst: async () => ({ systemManaged }) },
      channelMember: { findMany: async () => [] },
    } as unknown as PrismaClient,
    run: { principalUserId: runPrincipal },
  })

test('a private ordinary agent always resolves its owner’s browser jar', async () => {
  assert.equal(await principal(false, null), 'owner-1')
})

test('a system-managed agent keeps its requester-specific browser jar', async () => {
  assert.equal(await principal(true, 'requester-1'), 'requester-1')
})
