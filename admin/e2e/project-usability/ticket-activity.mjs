import assert from 'node:assert/strict'

// Real-stack ticket activity: a Markdown description, labels, a comment and an
// attachment, driven through the dialog a person uses against the real API.
// The pure-fixture half of this contract is admin/e2e/task-dialog/; this half
// proves the same controls persist and come back
// (docs/plans/2026-09-21-ticket-comments-attachments-labels/delivery.md §6.5).

const gotoBoard = async (page, adminUrl, projectId, boardId) => {
  await page.goto(`${adminUrl}/projects/${projectId}/board?board=${boardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-kanban-board-viewport]', { timeout: 60_000 })
}

const boardCard = (page, title) => page.locator('[data-kanban-card]').filter({ hasText: title }).first()

const openTaskDetails = async (page, title) => {
  await boardCard(page, title).click()
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  await dialog.getByRole('textbox', { name: 'Title' }).waitFor()
  return dialog
}

const closeTaskDetails = async (dialog) => {
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
  await dialog.waitFor({ state: 'hidden' })
}

// The Create row of the Labels token field — typing a name nobody has used
// offers it, and choosing it creates the project label and adds the pill.
const createLabelThroughField = async (page, dialog, name) => {
  const combobox = dialog.getByRole('combobox', { name: 'Labels' })
  await combobox.click()
  await combobox.fill(name)
  await page.getByRole('option', { name: `Create label “${name}”` }).click()
  await dialog.locator('.admin-token-input-token').filter({ hasText: name }).waitFor()
}

const cardShowsLabel = async (page, title, name) => {
  await boardCard(page, title).getByTestId('card-chips').getByText(name, { exact: true }).waitFor({ timeout: 20_000 })
}

/** Desktop: description, label, comment, attachment and the Labels settings rename. */
export const exerciseTicketActivity = async ({
  adminUrl, api, board, onTaskCreated, page, projectId, runId, shot, token, viewer,
}) => {
  const title = `QA activity ${runId}`
  const labelName = `qa-label-${runId}`
  const renamedLabel = `qa-renamed-${runId}`
  const commentText = `Comment from the browser ${runId}`
  const filename = `qa-attachment-${runId}.txt`

  await gotoBoard(page, adminUrl, projectId, board.id)
  const action = page.locator('[data-page-header-action="new-task"]:visible')
  if (await action.count()) await action.first().click()
  else { await page.getByRole('button', { name: 'More page actions' }).click(); await page.getByRole('menuitem', { name: 'New task' }).click() }
  const newDialog = page.getByRole('dialog', { name: 'New task' })
  await newDialog.getByRole('textbox', { name: 'Title' }).fill(title)
  // Typed, not filled: the editor's Markdown input rules turn `## ` into a
  // heading and `- ` into a list the way they do for a person at a keyboard.
  await newDialog.getByRole('textbox', { name: 'Description' }).click()
  await page.keyboard.type('## Acceptance criteria')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- First criterion')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second criterion')
  await newDialog.getByRole('button', { name: 'Create task' }).click()
  await newDialog.waitFor({ state: 'hidden' })
  await boardCard(page, title).waitFor()
  const task = (await api(`/api/projects/${projectId}/boards/${board.id}/tasks`, { token })).tasks.find((item) => item.title === title)
  assert.ok(task, 'the task created in the dialog is on the board')
  onTaskCreated(task.id)
  assert.match(task.detail ?? '', /^## Acceptance criteria/mu, 'the description is stored as Markdown with its heading')
  assert.match(task.detail ?? '', /^[-*] First criterion/mu, 'the description is stored as Markdown with its list')

  // Reopened, the read view renders the Markdown rather than echoing it.
  let dialog = await openTaskDetails(page, title)
  const readView = dialog.getByTestId('task-description-read')
  await readView.getByRole('heading', { name: 'Acceptance criteria' }).waitFor()
  assert.equal(await readView.getByRole('listitem').count(), 2, 'the description list renders as two list items')
  await readView.getByRole('listitem').filter({ hasText: 'Second criterion' }).waitFor()
  assert.equal(await readView.getByText('## Acceptance criteria').count(), 0, 'no raw Markdown in the read view')
  await dialog.getByRole('button', { name: 'Edit description' }).waitFor()

  await createLabelThroughField(page, dialog, labelName)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await cardShowsLabel(page, title, labelName)
  await shot(page, 'desktop-ticket-activity-card-label')

  // Comments and attachments save on their own, without Save changes.
  dialog = await openTaskDetails(page, title)
  // Reopened straight after the save, the dialog shows the label it saved —
  // not the record it cached on the first open.
  await dialog.locator('.admin-token-input-token').filter({ hasText: labelName }).waitFor({ timeout: 10_000 })
  const composer = dialog.getByRole('textbox', { name: 'Comment' })
  await composer.click()
  await page.keyboard.type(commentText)
  await dialog.getByRole('button', { name: 'Post', exact: true }).click()
  const comments = dialog.getByTestId('task-comments')
  const postedComment = comments.locator('li').filter({ hasText: commentText })
  await postedComment.waitFor({ timeout: 20_000 })
  await postedComment.getByText(viewer.displayName, { exact: true }).first().waitFor()

  const attachments = dialog.getByTestId('task-attachments')
  await attachments.getByTestId('task-attachments-input').setInputFiles({
    buffer: Buffer.from(`Attachment body ${runId}\n`),
    mimeType: 'text/plain',
    name: filename,
  })
  const attachmentRow = attachments.locator('li[data-attachment-id]').filter({ hasText: filename })
  await attachmentRow.waitFor({ timeout: 30_000 })
  const attachmentId = await attachmentRow.getAttribute('data-attachment-id')
  const listed = (await api(`/api/tasks/${task.id}/attachments`, { token })).attachments
  const stored = listed.find((item) => item.id === attachmentId)
  assert.ok(stored, 'the uploaded row is the ticket attachment the API lists')
  const downloaded = page.waitForResponse((response) => new URL(response.url()).pathname === stored.downloadPath)
  await attachmentRow.getByRole('button', { name: `Download ${filename}` }).click()
  const download = await downloaded
  assert.equal(download.status(), 200, 'the attachment download responds 200')
  await shot(page, 'desktop-ticket-activity-dialog')
  await closeTaskDetails(dialog)

  // Settings → Labels: rename, and the card follows.
  await page.goto(`${adminUrl}/projects/${projectId}/settings?section=labels`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: `Rename ${labelName}`, exact: true }).click({ timeout: 60_000 })
  const nameInput = page.getByRole('textbox', { name: `Name of ${labelName}`, exact: true })
  await nameInput.fill(renamedLabel)
  await nameInput.press('Enter')
  await page.getByRole('button', { name: `Rename ${renamedLabel}`, exact: true }).waitFor()
  await shot(page, 'desktop-ticket-activity-labels-settings')
  await gotoBoard(page, adminUrl, projectId, board.id)
  await cardShowsLabel(page, title, renamedLabel)
  assert.equal(
    await boardCard(page, title).getByTestId('card-chips').getByText(labelName, { exact: true }).count(),
    0,
    'the card no longer shows the old label name',
  )
  return { labelName: renamedLabel, title }
}

/** Phone: the details dialog stacks its groups and the label field still works. */
export const exerciseTicketActivityPhone = async ({ adminUrl, board, page, projectId, runId, shot, task }) => {
  const phoneLabel = `qa-phone-${runId}`
  await gotoBoard(page, adminUrl, projectId, board.id)
  const dialog = await openTaskDetails(page, task.title)
  const titleBox = await dialog.getByRole('textbox', { name: 'Title' }).boundingBox()
  const labelsBox = await dialog.getByRole('combobox', { name: 'Labels' }).boundingBox()
  const descriptionBox = await dialog.getByTestId('task-description-read').boundingBox()
  assert.ok(titleBox && labelsBox && descriptionBox, 'the phone dialog lays out Title, Labels and Description')
  assert.ok(titleBox.y + titleBox.height <= labelsBox.y, 'on a phone, Title sits above Labels')
  assert.ok(labelsBox.y + labelsBox.height <= descriptionBox.y, 'on a phone, Labels sits above Description')
  await dialog.locator('.admin-token-input-token').filter({ hasText: task.labelName }).waitFor()
  await createLabelThroughField(page, dialog, phoneLabel)
  await shot(page, 'phone-ticket-activity-labels')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await cardShowsLabel(page, task.title, phoneLabel)
  await cardShowsLabel(page, task.title, task.labelName)
}
