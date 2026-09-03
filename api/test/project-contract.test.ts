import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectRecordSchema, UpdateProjectBodySchema } from '../src/contracts/team.js'

test('project records carry a nullable emoji and photo identity', () => {
  const project = ProjectRecordSchema.parse({
    avatarAttachmentId: null,
    avatarEmoji: '🌿',
    channelCount: 2,
    createdAt: '2026-08-30T12:00:00.000Z',
    id: '00000000-0000-4000-8000-000000000001',
    memberCount: 3,
    name: 'Garden',
    organizationId: '00000000-0000-4000-8000-000000000002',
  })

  assert.equal(project.avatarEmoji, '🌿')
  assert.equal(project.avatarAttachmentId, null)
})

test('a project update can change its name, emoji, or photo but cannot be empty', () => {
  assert.deepEqual(UpdateProjectBodySchema.parse({ avatarEmoji: '🪴' }), { avatarEmoji: '🪴' })
  assert.deepEqual(UpdateProjectBodySchema.parse({
    avatarAttachmentId: '00000000-0000-4000-8000-000000000003',
  }), { avatarAttachmentId: '00000000-0000-4000-8000-000000000003' })
  assert.throws(() => UpdateProjectBodySchema.parse({}))
})
