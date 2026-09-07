import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('opening the same task after a realtime refresh keeps its selected dialog tab', () => {
  const dialog = readSource('../src/components/features/projects/kanban/TaskDialog.tsx')

  assert.match(dialog, /useTabParam\(\n    'taskTab'/)
  assert.match(dialog, /\}, \[open, setDialogTab, task\?\.id\]\)/)
  assert.doesNotMatch(dialog, /\}, \[open, task\]\)/)
})

test('checklist result drafts reset when the dialog changes task', () => {
  const checklist = readSource('../src/components/features/projects/kanban/TaskChecklistTab.tsx')

  assert.match(checklist, /setResults\(\{\}\)/)
  assert.match(checklist, /\}, \[taskId\]\)/)
})

test('task updates refresh an open checklist through the existing activity socket', () => {
  const realtime = readSource('../src/facades/agents/realtime.ts')

  assert.match(realtime, /message\.event === 'task\.updated'/)
  assert.match(realtime, /taskKeys\.checklist\(message\.data\.taskId\)/)
})
