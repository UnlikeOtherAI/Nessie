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
// offers it, and choosing it creates the label on the ticket's board and adds
// the pill.
const createLabelThroughField = async (page, dialog, name) => {
  const combobox = dialog.getByRole('combobox', { name: 'Labels' })
  await combobox.click()
  await combobox.fill(name)
  await page.getByRole('option', { name: `Create label “${name}”` }).click()
  await dialog.locator('.admin-token-input-token').filter({ hasText: name }).waitFor()
}

// The token field's footer is the doorway to the ticket's board's Labels tab.
const openLabelsFromField = async (page, dialog, projectId, boardId) => {
  await dialog.getByRole('combobox', { name: 'Labels' }).click()
  const manage = page.getByRole('link', { name: 'Manage labels…' })
  assert.equal(
    await manage.getAttribute('href'),
    `/projects/${projectId}/boards/${boardId}/settings?tab=labels`,
    "Manage labels… opens the ticket's own board's Labels tab",
  )
  await manage.click()
  await page.waitForURL((url) => url.pathname === `/projects/${projectId}/boards/${boardId}/settings`
    && url.searchParams.get('tab') === 'labels')
  await page.getByRole('tab', { name: 'Labels', selected: true }).waitFor({ timeout: 60_000 })
}

const cardShowsLabel = async (page, title, name) => {
  await boardCard(page, title).getByTestId('card-chips').getByText(name, { exact: true }).waitFor({ timeout: 20_000 })
}

/**
 * Desktop: description, label, comment, attachment and its removal with a
 * reason, the board's Labels rename, and the label following the ticket to
 * another board (board-labels-and-attachment-removal.md §10.5).
 */
export const exerciseTicketActivity = async ({
  adminUrl, api, board, onTaskCreated, page, projectId, runId, shot, token, viewer,
}) => {
  const title = `QA activity ${runId}`
  const labelName = `qa-label-${runId}`
  const renamedLabel = `qa-renamed-${runId}`
  const commentText = `Comment from the browser ${runId}`
  const filename = `qa-attachment-${runId}.txt`
  const removalReason = `Superseded in run ${runId}`

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
  await boardCard(page, title).locator('[title="1 file"]').waitFor({ timeout: 20_000 })

  // Removing is a mark: the row stays, says who and why, and still downloads.
  await attachmentRow.getByRole('button', { name: `Remove ${filename}` }).click()
  const confirm = page.getByRole('dialog', { name: `Remove “${filename}”?` })
  await confirm.getByRole('textbox', { name: 'Reason' }).fill(removalReason)
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
  await confirm.waitFor({ state: 'hidden' })
  await attachmentRow.and(page.locator('[data-attachment-removed="true"]')).waitFor({ timeout: 20_000 })
  const removalLine = attachmentRow.getByTestId('attachment-removal')
  await removalLine.getByText(viewer.displayName, { exact: true }).waitFor()
  await removalLine.getByText(`“${removalReason}”`, { exact: true }).waitFor()
  const removedRecord = (await api(`/api/tasks/${task.id}/attachments`, { token })).attachments
    .find((item) => item.id === attachmentId)
  assert.equal(removedRecord?.removed?.byUserId, viewer.id, 'the API records the signed-in person as the remover')
  assert.equal(removedRecord?.removed?.reason, removalReason, 'and the reason they gave')
  const redownloaded = page.waitForResponse((response) => new URL(response.url()).pathname === stored.downloadPath)
  await attachmentRow.getByRole('button', { name: `Download ${filename}` }).click()
  assert.equal((await redownloaded).status(), 200, 'a removed attachment still downloads')
  await shot(page, 'desktop-ticket-activity-attachment-removed')
  await closeTaskDetails(dialog)
  // The card's paperclip counts live files only; the one file is removed.
  await boardCard(page, title).locator('[title="1 file"]').waitFor({ state: 'detached', timeout: 20_000 })

  // Board → Settings → Labels, reached from the token field: rename, and the card follows.
  dialog = await openTaskDetails(page, title)
  await openLabelsFromField(page, dialog, projectId, board.id)
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

  // A label belongs to a board and follows the ticket by name. The dialog's
  // column field offers the ticket's own board only, so the cross-board move
  // is the move route a drop onto another board's column calls.
  const otherBoard = await api(`/api/projects/${projectId}/boards`, {
    body: { copyColumnsFromBoardId: board.id, name: `Labels move ${runId}` }, method: 'POST', token,
  })
  const otherColumn = [...otherBoard.columns].sort((left, right) => left.position - right.position)[0]
  assert.ok(otherColumn, 'the second board has a column')
  await api(`/api/tasks/${task.id}/move`, { body: { columnId: otherColumn.id }, method: 'POST', token })
  await gotoBoard(page, adminUrl, projectId, otherBoard.id)
  await cardShowsLabel(page, title, renamedLabel)
  dialog = await openTaskDetails(page, title)
  await dialog.locator('.admin-token-input-token').filter({ hasText: renamedLabel }).waitFor({ timeout: 10_000 })
  await openLabelsFromField(page, dialog, projectId, otherBoard.id)
  await page.getByRole('button', { name: `Rename ${renamedLabel}`, exact: true }).waitFor({ timeout: 60_000 })
  const otherLabels = (await api(`/api/projects/${projectId}/boards/${otherBoard.id}/labels`, { token })).labels
  assert.ok(
    otherLabels.some((label) => label.name === renamedLabel && label.boardId === otherBoard.id),
    "the label is now the second board's own",
  )
  await shot(page, 'desktop-ticket-activity-labels-followed')

  // Back where it started, for the phone half; the label comes with it again.
  const firstColumn = [...board.columns].sort((left, right) => left.position - right.position)[0]
  await api(`/api/tasks/${task.id}/move`, { body: { columnId: firstColumn.id }, method: 'POST', token })
  await gotoBoard(page, adminUrl, projectId, board.id)
  await cardShowsLabel(page, title, renamedLabel)
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
