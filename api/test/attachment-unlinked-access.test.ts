import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { canAccessAttachment } from '../src/services/attachments.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const uploaderId = '00000000-0000-4000-8000-000000000002'
const otherMemberId = '00000000-0000-4000-8000-000000000003'
const attachmentId = '00000000-0000-4000-8000-000000000004'

type Published = {
  userAvatar?: boolean
  agentAvatar?: boolean
  projectAvatar?: boolean
  orgLogo?: boolean
  feedback?: boolean
}

/**
 * Every reference `isPublishedOrgAsset` counts needs a delegate here, and the
 * stub is cast, so a model it forgets is `undefined` at call time rather than a
 * type error — `project` was missed when project avatars were added and took
 * five of these tests down with a bare TypeError. A published-reference kind
 * added to that function is added here in the same change, with a case below.
 */
const makePrisma = (published: Published = {}): PrismaClient =>
  ({
    knowledgePageVersion: { findFirst: async () => null },
    user: { count: async () => (published.userAvatar ? 1 : 0) },
    agent: { count: async () => (published.agentAvatar ? 1 : 0) },
    project: { count: async () => (published.projectAvatar ? 1 : 0) },
    organization: { count: async () => (published.orgLogo ? 1 : 0) },
    feedback: { count: async () => (published.feedback ? 1 : 0) },
  }) as unknown as PrismaClient

const unlinked = {
  id: attachmentId,
  organizationId,
  messageId: null,
  knowledgePageId: null,
  uploaderId,
}

test('the uploader can read their own not-yet-linked upload', async () => {
  const allowed = await canAccessAttachment(makePrisma(), unlinked, {
    organizationId,
    userId: uploaderId,
  })
  assert.equal(allowed, true)
})

test('another member cannot read an unpublished pending upload', async () => {
  // This is the leak: a draft attachment, or one whose message send was
  // abandoned, has no message and no published reference. Org membership alone
  // used to be enough to fetch its bytes by id.
  const allowed = await canAccessAttachment(makePrisma(), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, false)
})

test('a published user avatar stays readable org-wide', async () => {
  const allowed = await canAccessAttachment(makePrisma({ userAvatar: true }), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a published agent avatar stays readable org-wide', async () => {
  const allowed = await canAccessAttachment(makePrisma({ agentAvatar: true }), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a published project avatar stays readable org-wide', async () => {
  // The kind that had no case: project avatars became a published reference
  // without one, so nothing asserted that a member other than the uploader can
  // read the picture on a project they can already see.
  const allowed = await canAccessAttachment(makePrisma({ projectAvatar: true }), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('the organization logo stays readable org-wide', async () => {
  const allowed = await canAccessAttachment(makePrisma({ orgLogo: true }), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a feedback attachment stays readable org-wide', async () => {
  const allowed = await canAccessAttachment(makePrisma({ feedback: true }), unlinked, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a cross-organization attachment is refused before any lookup', async () => {
  const allowed = await canAccessAttachment(makePrisma({ userAvatar: true }), unlinked, {
    organizationId: '00000000-0000-4000-8000-0000000000ff',
    userId: uploaderId,
  })
  assert.equal(allowed, false)
})

test('a knowledge-base blob is still refused on this generic endpoint', async () => {
  const allowed = await canAccessAttachment(
    makePrisma({ userAvatar: true }),
    { ...unlinked, knowledgePageId: '00000000-0000-4000-8000-00000000000a' },
    { organizationId, userId: uploaderId },
  )
  assert.equal(allowed, false)
})
