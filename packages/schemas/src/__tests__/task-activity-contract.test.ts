import assert from 'node:assert/strict'
import test from 'node:test'

import { BoardSourceFieldTargetSchema } from '../board-sources.js'
import { WsEventNameSchema, WsEventSchema } from '../realtime-ws.js'
import {
  INLINE_ATTACHMENT_PATH,
  inlineAttachmentIds,
  inlineAttachmentPath,
} from '../task-attachments.js'
import { CreateTaskCommentBodySchema, TASK_COMMENT_MAX_CHARS } from '../task-comments.js'
import {
  CreateTaskLabelBodySchema,
  LabelColorSchema,
  TaskLabelIdsSchema,
  normalizeLabelName,
} from '../task-labels.js'

const A = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const B = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const C = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'

test('inlineAttachmentIds finds images and links in the inline form, in order, once each', () => {
  const markdown = [
    '# Repro',
    `![screenshot](/api/attachments/${A})`,
    `See [the log](/api/attachments/${B} "server log") and again ![](${inlineAttachmentPath(A)}).`,
    `An angle-bracket destination: ![x](</api/attachments/${C}>)`,
  ].join('\n')
  assert.deepEqual(inlineAttachmentIds(markdown), [A, B, C])
})

test('inlineAttachmentIds ignores other URLs and near misses', () => {
  const markdown = [
    '![remote](https://uploads.linear.app/abc/def.png)',
    `![relative](api/attachments/${A})`,
    `![thumb](/api/attachments/${A}/thumbnail)`,
    `![query](/api/attachments/${A}?download=1)`,
    `bare text /api/attachments/${B} is not a reference`,
    '![short](/api/attachments/1234)',
  ].join('\n')
  assert.deepEqual(inlineAttachmentIds(markdown), [])
})

test('inlineAttachmentIds skips references inside code', () => {
  const markdown = [
    '```md',
    `![in fence](/api/attachments/${A})`,
    '```',
    `Inline \`![code](/api/attachments/${B})\` stays text.`,
    `~~~`,
    `![tilde fence](/api/attachments/${B})`,
    `~~~`,
    `![real](/api/attachments/${C})`,
  ].join('\n')
  assert.deepEqual(inlineAttachmentIds(markdown), [C])
})

test('inlineAttachmentIds tolerates escaped brackets in alt text and empty input', () => {
  assert.deepEqual(inlineAttachmentIds(`![a \\] b](/api/attachments/${A})`), [A])
  assert.deepEqual(inlineAttachmentIds(''), [])
})

test('INLINE_ATTACHMENT_PATH matches exactly the path the editor inserts', () => {
  assert.equal(INLINE_ATTACHMENT_PATH.exec(inlineAttachmentPath(A))?.[1], A)
  assert.equal(INLINE_ATTACHMENT_PATH.test(`${inlineAttachmentPath(A)}/thumbnail`), false)
})

test('labels: colour is lower-case #rrggbb, names normalise, ids are a set', () => {
  assert.equal(LabelColorSchema.safeParse('#3b82f6').success, true)
  assert.equal(LabelColorSchema.safeParse('#3B82F6').success, false)
  assert.equal(LabelColorSchema.safeParse('3b82f6').success, false)
  assert.equal(normalizeLabelName('  Bug '), 'bug')
  assert.equal(CreateTaskLabelBodySchema.safeParse({ name: 'x'.repeat(61) }).success, false)
  assert.equal(CreateTaskLabelBodySchema.safeParse({ name: 'perf', tone: 'red' }).success, false)
  assert.equal(TaskLabelIdsSchema.safeParse([A, B]).success, true)
  assert.equal(TaskLabelIdsSchema.safeParse([A, A]).success, false)
})

test('comment bodies are bounded and strict', () => {
  assert.equal(CreateTaskCommentBodySchema.safeParse({ body: '' }).success, false)
  assert.equal(
    CreateTaskCommentBodySchema.safeParse({ body: 'x'.repeat(TASK_COMMENT_MAX_CHARS + 1) }).success,
    false,
  )
  assert.equal(CreateTaskCommentBodySchema.safeParse({ body: 'ok', attachmentIds: [A] }).success, true)
  assert.equal(CreateTaskCommentBodySchema.safeParse({ body: 'ok', authorUserId: A }).success, false)
})

test('native:labels is a board-source field target', () => {
  assert.equal(BoardSourceFieldTargetSchema.safeParse('native:labels').success, true)
})

test('task.activity rides the unchanged event envelope, content-free', () => {
  assert.equal(WsEventNameSchema.safeParse('task.activity').success, true)
  const message = {
    type: 'event',
    event: 'task.activity',
    data: { taskId: A, projectId: B },
    ts: '2026-09-21T12:00:00.000Z',
  }
  assert.deepEqual(WsEventSchema.parse(message), message)
  assert.equal(
    WsEventSchema.safeParse({ ...message, data: { taskId: A } }).success,
    false,
  )
})
