import assert from 'node:assert/strict'
import { test } from 'node:test'

import { grantMessageDisclosure } from '../src/disclosure-grants.js'

test('renewing a one-message grant records the current approving author', async () => {
  let update: Record<string, unknown> | undefined
  const prisma = {
    agent: { findMany: async () => [] },
    channel: { findFirst: async () => ({ id: 'audience-channel' }) },
    channelMember: { findMany: async () => [{ channelId: 'source-channel' }] },
    disclosureGrant: {
      upsert: async (input: { update: Record<string, unknown> }) => {
        update = input.update
        return { id: 'grant-1' }
      },
    },
    message: {
      findFirst: async () => ({
        agentId: 'agent-1',
        basisScopes: [{ scopeId: 'org-1', scopeType: 'organization' }],
        content: 'restricted',
        disclosureSources: [],
        id: 'message-1',
        thread: { channelId: 'source-channel' },
      }),
    },
    organization: { findUnique: async () => ({ externalOrgId: null }) },
    organizationMember: { findFirst: async () => ({ id: 'membership-1' }) },
    productAccountLink: { findUnique: async () => null },
    projectMember: { findMany: async () => [] },
    team: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    $executeRaw: async () => 0,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  }

  await grantMessageDisclosure(prisma as never, {
    audienceId: 'audience-channel',
    expectedContent: 'restricted',
    messageId: 'message-1',
    organizationId: 'org-1',
    userId: 'author-b',
  })

  assert.equal(update?.grantedByUserId, 'author-b')
  assert.equal(update?.revokedAt, null)
})
