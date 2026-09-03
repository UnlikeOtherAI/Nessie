import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVisibleAgentWhere } from '../src/agent-visibility.js'
import { visibleKnowledgeSpaceWhere } from '../src/knowledge-space-visibility.js'
import { visibleUserAlertWhere } from '../src/user-alerts.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'

test('visibleKnowledgeSpaceWhere gives agent-owned spaces the live agent audience', () => {
  assert.deepEqual(visibleKnowledgeSpaceWhere({ organizationId, userId }), {
    deletedAt: null,
    organizationId,
    OR: [
      {
        ownerAgentId: { not: null },
        OR: [
          { members: { some: { userId } } },
          { ownerAgent: { is: buildVisibleAgentWhere({ organizationId, userId }) } },
        ],
      },
      {
        ownerAgentId: null,
        OR: [
          { createdBy: userId },
          { members: { some: { userId } } },
          { visibility: 'organization' },
          {
            visibility: 'project',
            project: { members: { some: { userId } } },
          },
        ],
      },
    ],
  })
})

test('visibleUserAlertWhere composes the shared knowledge-space predicate', () => {
  const where = visibleUserAlertWhere({ organizationId, userId })
  const knowledgePublished = where.OR?.find((arm) => arm.kind === 'knowledge_published')

  assert.deepEqual(knowledgePublished?.knowledgePage?.is?.space?.is, visibleKnowledgeSpaceWhere({
    organizationId,
    userId,
  }))
})

test('team invitation visibility relies on the outer active membership gate', () => {
  const where = visibleUserAlertWhere({ organizationId, userId })
  assert.deepEqual(
    where.OR?.find((arm) => arm.kind === 'team_invitation'),
    { kind: 'team_invitation' },
  )
  assert.deepEqual(where.user, {
    organizationMembers: {
      some: { deactivatedAt: null, organizationId },
    },
  })
})
