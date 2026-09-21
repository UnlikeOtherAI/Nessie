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
  /** The viewer can see the agent whose mailbox this email attachment belongs to. */
  emailReadable?: boolean
  /** The viewer is a member of the project whose ticket carries this file. */
  taskReadable?: boolean
  /** The viewer's organisation role, read when the caller does not pass it. */
  role?: string
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
    agent: {
      count: async (args?: { where?: { id?: string } }) => {
        // `isAgentVisibleToUser` counts by agent id; `isPublishedOrgAsset`
        // counts by avatar reference. One delegate, two callers.
        if (args?.where?.id) return published.emailReadable ? 1 : 0
        return published.agentAvatar ? 1 : 0
      },
    },
    project: { count: async () => (published.projectAvatar ? 1 : 0) },
    organization: { count: async () => (published.orgLogo ? 1 : 0) },
    feedback: { count: async () => (published.feedback ? 1 : 0) },
    // The email arm resolves the mailbox's AGENT and then asks the shared
    // agent-visibility predicate, so both delegates are modelled: the message
    // exists, and `agent.count` is what decides whether the viewer may read it.
    emailMessage: {
      findFirst: async () => ({ mailbox: { agentId: '00000000-0000-4000-8000-0000000000ee' } }),
    },
    // The task arm asks the shared `isTaskAccessibleToUser`: the viewer's
    // role (when not passed), their project memberships, then whether the
    // task is inside that visibility. The count stands in for the last query.
    organizationMember: {
      findUnique: async () => ({ role: published.role ?? 'member', deactivatedAt: null }),
    },
    projectMember: {
      findMany: async () => (published.taskReadable ? [{ projectId: '00000000-0000-4000-8000-0000000000aa' }] : []),
    },
    task: {
      count: async (args: { where: { AND?: unknown[] } }) => {
        const visibility = JSON.stringify(args.where.AND ?? [])
        // An admin's query carries no project-id filter (`projectId: { in }`) at all.
        if (!visibility.includes('"in"')) return 1
        return published.taskReadable ? 1 : 0
      },
    },
  }) as unknown as PrismaClient

const unlinked = {
  id: attachmentId,
  organizationId,
  messageId: null,
  knowledgePageId: null,
  emailMessageId: null,
  taskId: null,
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

test('an email attachment is readable by someone who can see its agent', async () => {
  const allowed = await canAccessAttachment(
    makePrisma({ emailReadable: true }),
    { ...unlinked, emailMessageId: '00000000-0000-4000-8000-00000000000b', uploaderId: null },
    { organizationId, userId: otherMemberId },
  )
  assert.equal(allowed, true)
})

test('an email attachment is refused to someone who cannot see its agent', async () => {
  // The byte surface closes with the conversation surface: both ask agent
  // visibility, so a mailbox that goes dark takes its attachments with it —
  // and a published avatar elsewhere in the org does not open them.
  const allowed = await canAccessAttachment(
    makePrisma({ userAvatar: true }),
    { ...unlinked, emailMessageId: '00000000-0000-4000-8000-00000000000b', uploaderId: null },
    { organizationId, userId: otherMemberId },
  )
  assert.equal(allowed, false)
})

const onTask = { ...unlinked, taskId: '00000000-0000-4000-8000-00000000000c', uploaderId: null }

test('a ticket file is readable by a member of the ticket\'s project', async () => {
  const allowed = await canAccessAttachment(makePrisma({ taskReadable: true }), onTask, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a ticket file is refused to somebody outside the ticket\'s project', async () => {
  // A published avatar elsewhere does not open it: the task arm answers alone.
  const allowed = await canAccessAttachment(makePrisma({ userAvatar: true }), onTask, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, false)
})

test('an organisation admin reads a ticket file without being a project member', async () => {
  const allowed = await canAccessAttachment(makePrisma({ role: 'admin' }), onTask, {
    organizationId,
    userId: otherMemberId,
  })
  assert.equal(allowed, true)
})

test('a removed ticket file stays readable through the ticket, and only through it', async () => {
  // Removal marks the row and keeps the bytes; the task arm does not look at the mark.
  const removed = {
    ...onTask,
    removedAt: new Date('2026-09-21T10:00:00Z'),
    removedByUserId: otherMemberId,
    removedByAgentId: null,
    removedReason: 'Superseded by v2',
  }
  assert.equal(
    await canAccessAttachment(makePrisma({ taskReadable: true }), removed, { organizationId, userId: otherMemberId }),
    true,
  )
  assert.equal(
    await canAccessAttachment(makePrisma(), removed, { organizationId, userId: otherMemberId }),
    false,
  )
})
