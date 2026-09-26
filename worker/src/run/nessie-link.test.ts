import assert from 'node:assert/strict'
import test from 'node:test'
import { runNessieLink } from './nessie-link.js'

test('names link directly to documents, conversations, tickets and machines', () => {
  const examples = [
    [{ kind: 'space', id: 'space', name: 'CTO — Documents' }, '/knowledge-base/spaces/space'],
    [{ kind: 'document', id: 'page', spaceId: 'space', name: 'Plan' }, '/knowledge-base/spaces/space?pageId=page'],
    [{ kind: 'ticket', id: 'task', projectId: 'project', name: 'Fix' }, '/projects/project/board?task=task'],
    [{ kind: 'terminal', id: 'session', executorId: 'machine', name: 'Minis' }, '/agents/executors/machine/sessions/session'],
    [{ kind: 'message', id: 'reply', rootMessageId: 'root', channelId: 'channel', threadId: 'thread', name: 'Answer' },
      '/channels/channel/threads/thread/replies/root'],
  ] as const
  for (const [input, path] of examples) {
    assert.equal(runNessieLink(input).output, `[${input.name}](${path})`)
  }
})

test('link construction rejects missing context and escapes untrusted names and path segments', () => {
  const missingParent = runNessieLink({ kind: 'document', id: 'page', name: 'Plan' })
  assert.equal(missingParent.correctable, true)
  assert.equal(missingParent.success, false)
  assert.match(missingParent.output, /spaceId is required/)
  assert.match(runNessieLink({ kind: 'unsupported', id: 'id', name: 'Name' }).output, /supported/)
  assert.equal(runNessieLink({ kind: 'space', id: 'a/b?x=y', name: 'A [link]' }).output,
    '[A \\[link\\]](/knowledge-base/spaces/a%2Fb%3Fx%3Dy)')
})
