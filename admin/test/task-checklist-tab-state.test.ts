import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

test('opening the same task after a realtime refresh keeps its selected dialog tab', () => {
  const dialog = readSource('../src/components/features/projects/kanban/TaskDialog.tsx')

  assert.match(dialog, /useTabParam\(\n    'taskTab'/)
  assert.match(dialog, /\}, \[open, setDialogTab, task\?\.id\]\)/)
  assert.doesNotMatch(dialog, /\}, \[open, task\]\)/)
})

test('checklist result drafts are scoped to a task and yield to a saved result', () => {
  const checklist = readSource('../src/components/features/projects/kanban/TaskChecklistTab.tsx')

  assert.match(checklist, /useDraft<Record<string, string>>\(draftKey\('task-checklist', taskId\)/)
  assert.match(checklist, /if \(resultsRef\.current\[step\.key\] === savedResult\)/)
  assert.match(checklist, /delete next\[step\.key\]/)
})

test('checklist saves handle failures and block a step while its write is pending', () => {
  const checklist = readSource('../src/components/features/projects/kanban/TaskChecklistTab.tsx')

  assert.match(checklist, /await updateStep\.mutateAsync\(/)
  assert.match(checklist, /catch \(cause\)/)
  assert.match(checklist, /disabled=\{pending\}/)
  assert.match(checklist, /\{pending \? 'Saving…' : 'Save result'\}/)
  assert.match(checklist, /role="status"/)
})

test('task updates refresh an open checklist through the existing activity socket', () => {
  const realtime = readSource('../src/facades/agents/realtime.ts')

  assert.match(realtime, /message\.event === 'task\.updated'/)
  assert.match(realtime, /taskKeys\.checklist\(message\.data\.taskId\)/)
})
