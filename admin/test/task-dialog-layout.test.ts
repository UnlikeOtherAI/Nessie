import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The ticket dialog's layout contract (docs/plans/2026-09-21-ticket-comments-
 * attachments-labels/ui.md §5.2), held at the source so a refactor that moves a
 * section cannot pass unnoticed between browser-suite runs.
 *
 * The complaint it answers: Documents rendered below the whole two-column
 * grid, so every label added to the right column pushed it further down. The
 * fix is structural — three groups whose DOM order is the phone order, with
 * Description · Documents · Attachments · Comments in the body group — and
 * `admin/e2e/task-dialog` measures the same thing in a browser.
 */

const read = (relativePath: string): string =>
  readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8')

const dialog = read('components/features/projects/kanban/TaskDialog.tsx')

const indexOf = (needle: string): number => {
  const at = dialog.indexOf(needle)
  assert.notEqual(at, -1, `TaskDialog.tsx renders ${needle}`)
  return at
}

test('the form is three groups in phone order: head, meta, body', () => {
  const head = indexOf('className="task-dialog-head"')
  const meta = indexOf('className="task-dialog-meta"')
  const body = indexOf('className="task-dialog-body"')
  assert.ok(head < meta && meta < body)
  assert.match(dialog, /'task-dialog-form'/)
  // No second grid of its own: the geometry lives in styles.css.
  assert.doesNotMatch(dialog, /md:grid-cols-\[1\.7fr_1fr\]/)
  assert.doesNotMatch(dialog, /md:col-span-2/)
})

test('Documents sits directly under the description, then Attachments, then Comments', () => {
  const body = indexOf('className="task-dialog-body"')
  const description = indexOf('<TaskDescriptionField')
  const documents = indexOf('<TaskDocuments')
  const attachments = indexOf('<TaskAttachmentsSection')
  const comments = indexOf('<TaskCommentsSection')
  assert.ok(body < description && description < documents && documents < attachments && attachments < comments)
})

test('Labels is a field of the meta group, after Column', () => {
  const meta = indexOf('className="task-dialog-meta"')
  const column = indexOf('<TaskPlacementField')
  const labels = indexOf('<TaskLabelsField')
  const body = indexOf('className="task-dialog-body"')
  assert.ok(meta < column && column < labels && labels < body)
})

test('the description is the Markdown field, named Description', () => {
  assert.doesNotMatch(dialog, /label="Detail"/)
  const field = read('components/features/projects/kanban/TaskDescriptionField.tsx')
  assert.match(field, /ariaLabel="Description"/)
  assert.match(field, /resolveAttachmentImages/)
})

test('no section in the body draws a bordered box inside the dialog', () => {
  for (const file of ['TaskDocuments.tsx', 'TaskAttachmentsSection.tsx', 'TaskCommentsSection.tsx']) {
    const source = read(`components/features/projects/kanban/${file}`)
    assert.doesNotMatch(source, /rounded-md border border-\[color:var\(--sep\)\] p-3/, `${file} keeps no box`)
  }
})

test('Settings → Labels is a section of the project settings strip', () => {
  const page = read('pages/project/ProjectSettingsPage.tsx')
  assert.match(page, /const SECTIONS = \['fields', 'labels', 'sources'\] as const/)
  assert.match(page, /\{ label: 'Labels', value: 'labels' \}/)
  assert.match(page, /<LabelsSettingsSection/)
  const field = read('components/features/projects/kanban/TaskLabelsField.tsx')
  assert.match(field, /settings\?section=labels/)
})

test('a card reads a Markdown description as words, not syntax', async () => {
  const { markdownToPlainText } = await import('../src/components/features/projects/kanban/KanbanCard')
  const text = markdownToPlainText(
    '## Plan\n\n- first step\n- **second** with [a link](https://x.test)\n\n![shot](/api/attachments/0d101a5e-e58b-4dc8-b138-64c9d68b1337)',
  ).replace(/\s+/g, ' ').trim()
  assert.equal(text, 'Plan first step second with a link')
})
