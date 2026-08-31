import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('knowledge-space member selection uses one parameterized checklist for people and agents', () => {
  const createSpace = source('../src/components/features/knowledge/CreateSpaceDialog.tsx')
  const settings = source('../src/components/features/knowledge/SpaceSettingsDialog.tsx')
  const checklist = source('../src/components/features/knowledge/MemberChecklist.tsx')

  assert.match(createSpace, /<MemberChecklist/)
  assert.match(settings, /<MemberChecklist/g)
  assert.match(checklist, /Shared checkbox list for either human or agent KnowledgeSpaceMember rows/)
  assert.equal(
    existsSync(fileURLToPath(new URL('../src/components/features/knowledge/AgentMemberChecklist.tsx', import.meta.url))),
    false,
  )
  assert.equal(
    existsSync(fileURLToPath(new URL('../src/components/features/knowledge/UserMemberChecklist.tsx', import.meta.url))),
    false,
  )
})
