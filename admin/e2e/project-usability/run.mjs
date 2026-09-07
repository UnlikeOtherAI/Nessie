#!/usr/bin/env node
// Durable browser coverage for project management's core question:
// can a person create, edit and move a ticket, understand board ownership,
// and still reach later columns on a touch-sized viewport?
//
// The suite adopts the root dev servers on 5454/5455. It never starts or stops
// a server, because the shared local loop belongs to the caller.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ADMIN_PORT, API_URL, databaseUrl } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam, call } from '../navigation/lib/seed.mjs'

const ADMIN_URL = `http://localhost:${ADMIN_PORT}`
const SCREENSHOTS = fileURLToPath(new URL('../../../e2e/screenshots/project-usability/', import.meta.url))
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const skip = (reason) => {
  console.log(`project-usability e2e: SKIPPED — ${reason}`)
  process.exit(0)
}

const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    await response.arrayBuffer()
    return response.status < 500
  } catch {
    return false
  }
}

const api = async (path, { body, method = 'GET', token } = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
  return payload?.data ?? payload
}

const goto = async (page, path) => {
  await page.goto(`${ADMIN_URL}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-kanban-board-viewport]', { timeout: 60_000 })
}

const gotoBoardList = async (page, projectId) => {
  await page.goto(`${ADMIN_URL}/projects/${projectId}/boards`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Boards', exact: true }).waitFor({ timeout: 60_000 })
  await page.getByRole('table', { name: 'Project boards' }).waitFor({ timeout: 60_000 })
}

const boardListRow = (page, name) => page.getByRole('row').filter({ hasText: name })

const waitForBoard = async (token, projectId, name, expected = {}) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const boards = await call(`/api/projects/${projectId}/boards`, { token })
    const board = boards.find((item) => item.name === name)
    if (board && Object.entries(expected).every(([key, value]) => board[key] === value)) return board
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`board ${JSON.stringify(name)} did not reach ${JSON.stringify(expected)}`)
}

const waitForWatcher = async (token, projectId, boardId, recipientId) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const watchers = await api(`/api/projects/${projectId}/boards/${boardId}/watchers`, { token })
    if (watchers.some((watcher) => watcher.recipientId === recipientId)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`board ${boardId} did not save watcher ${recipientId}`)
}

const createBoardThroughUi = async (page, projectId, name, sourceBoardId) => {
  await gotoBoardList(page, projectId)
  await page.getByRole('button', { name: 'New board', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New board' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByLabel('Starting columns').selectOption(sourceBoardId)
  const create = dialog.getByRole('button', { name: 'Create board' })
  assert.ok(await create.isVisible(), 'New board keeps its primary Create board action visible')
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/[^/]+/settings\\?tab=general$`, 'u'))
}

const openNewTask = async (page) => {
  const action = page.locator('[data-page-header-action="new-task"]:visible')
  if (await action.count()) {
    await action.first().click()
  } else {
    await page.getByRole('button', { name: 'More page actions' }).click()
    await page.getByRole('menuitem', { name: 'New task' }).click()
  }
  return page.getByRole('dialog', { name: 'New task' })
}

const createTaskThroughUi = async (page, title, detail) => {
  const dialog = await openNewTask(page)
  await dialog.getByRole('textbox', { name: 'Title' }).fill(title)
  if (detail) await dialog.getByRole('textbox', { name: 'Detail' }).fill(detail)
  const create = dialog.getByRole('button', { name: 'Create task' })
  assert.ok(await create.isVisible(), 'New task keeps its primary Create task action visible')
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('[data-kanban-card]').filter({ hasText: title }).waitFor()
}

const editTaskThroughUi = async (page, title, editedTitle) => {
  const card = page.locator('[data-kanban-card]').filter({ hasText: title }).first()
  await card.click()
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  await dialog.getByRole('textbox', { name: 'Title' }).fill(editedTitle)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('[data-kanban-card]').filter({ hasText: editedTitle }).waitFor()
}

const moveTaskThroughUi = async (page, title, column) => {
  const card = page.locator('[data-kanban-card]').filter({ hasText: title }).first()
  await card.click()
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  const columnField = dialog.getByLabel('Column')
  assert.equal(await columnField.count(), 1, 'task details exposes the labelled Column control')
  await columnField.selectOption(column.id)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'hidden' })
}

const waitForBoardTask = async (token, projectId, boardId, title, expectedColumnId) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await api(`/api/projects/${projectId}/boards/${boardId}/tasks`, { token })
    const task = result.tasks.find((item) => item.title === title)
    if (task && (!expectedColumnId || task.columnId === expectedColumnId)) return task
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`board ${boardId} did not expose "${title}" in column ${expectedColumnId ?? 'any'}`)
}

// Board administration is deliberately driven through its own list and detail
// routes. Creating a board from the board screen used to hide the home for
// management, which meant a person could not discover the rest of the work
// after the first creation.
const exerciseBoardManagement = async ({ page, projectId, sourceBoard, token }) => {
  const boardName = `Managed board ${runId}`
  const renamedBoardName = `Managed board renamed ${runId}`
  const columnName = `Ready for review ${runId}`
  const me = await api('/api/auth/me', { token })
  const watcherName = me.user.displayName

  await gotoBoardList(page, projectId)
  const table = page.getByRole('table', { name: 'Project boards' })
  const sourceRow = boardListRow(page, sourceBoard.name)
  await sourceRow.waitFor()
  assert.match(await sourceRow.first().innerText(), /Kanban|Iterations/u, 'board list names the board style')
  assert.match(await sourceRow.first().innerText(), /columns/u, 'board list names the column count')
  assert.match(await sourceRow.first().innerText(), /Default/u, 'board list names the default board')
  assert.equal(await table.getByRole('link', { name: 'Open board' }).count() > 0, true, 'each board has an Open board doorway')
  assert.equal(await table.getByRole('link', { name: 'Settings' }).count() > 0, true, 'each board has a Settings doorway')

  await createBoardThroughUi(page, projectId, boardName, sourceBoard.id)
  const board = await waitForBoard(token, projectId, boardName)
  const generalPath = `/projects/${projectId}/boards/${board.id}/settings?tab=general`
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, generalPath, 'creation lands on the new board’s general settings')
  await page.getByRole('heading', { name: boardName, exact: true }).waitFor()
  const settingsTabs = page.getByRole('tablist', { name: 'Board settings' })
  assert.equal(await settingsTabs.getByRole('tab', { name: 'General' }).getAttribute('aria-selected'), 'true', 'general is selected after creation')

  // A list row is the in-context doorway back to a working board. Its URL is
  // inspectable as well as clickable, so it keeps the selected board shareable.
  await gotoBoardList(page, projectId)
  const boardRow = boardListRow(page, boardName)
  const openBoard = boardRow.getByRole('link', { name: 'Open board' })
  await openBoard.click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/board\\?board=${board.id}$`, 'u'))
  await page.waitForSelector('[data-kanban-board-viewport]', { timeout: 60_000 })
  await page.goBack()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))

  // General is the only tab that changes board identity and style. The API
  // reads below verify persistence rather than merely a React Query repaint.
  await boardListRow(page, boardName).getByRole('link', { name: 'Settings' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=general$`, 'u'))
  const nameField = page.getByLabel('Board name')
  await nameField.fill(renamedBoardName)
  await nameField.blur()
  await waitForBoard(token, projectId, renamedBoardName)
  const style = page.getByLabel('Board style')
  await style.selectOption('scrum')
  await waitForBoard(token, projectId, renamedBoardName, { style: 'scrum' })
  await style.selectOption('kanban')
  await waitForBoard(token, projectId, renamedBoardName, { style: 'kanban' })
  await page.getByRole('button', { name: /make default/i }).click()
  await waitForBoard(token, projectId, renamedBoardName, { isDefault: true })

  await settingsTabs.getByRole('tab', { name: 'Columns' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=columns$`, 'u'))
  assert.equal(await page.getByLabel('Board name').count(), 0, 'Columns does not retain General controls')
  const newColumn = page.getByLabel('New column name')
  await newColumn.fill(columnName)
  await page.getByRole('button', { name: 'Add column' }).click()
  const boardWithColumn = await waitForBoard(token, projectId, renamedBoardName)
  assert.ok(boardWithColumn.columns.some((column) => column.name === columnName), 'Columns creates a board-local column')

  await settingsTabs.getByRole('tab', { name: 'Watchers' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=watchers$`, 'u'))
  assert.equal(await page.getByLabel('New column name').count(), 0, 'Watchers does not retain Columns controls')
  const recipients = page.getByLabel('Tell')
  await recipients.fill(watcherName)
  await page.getByRole('button', { name: watcherName, exact: true }).click()
  await page.getByRole('button', { name: 'Save watchers' }).click()
  await waitForWatcher(token, projectId, board.id, me.user.id)

  // A pasted link chooses its stated tab. Browser Back returns to the list a
  // person came from, rather than leaving an unreachable settings layer.
  await gotoBoardList(page, projectId)
  await boardListRow(page, renamedBoardName).getByRole('link', { name: 'Settings' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=general$`, 'u'))
  await page.goBack()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  await page.goto(`${ADMIN_URL}/projects/${projectId}/boards/${board.id}/settings?tab=watchers`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: renamedBoardName, exact: true }).waitFor()
  assert.equal(await settingsTabs.getByRole('tab', { name: 'Watchers' }).getAttribute('aria-selected'), 'true', 'a settings deep link selects its stated tab')

  await page.goto(`${ADMIN_URL}/projects/${projectId}/settings?section=boards&board=${board.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=general$`, 'u'))
  await page.goto(`${ADMIN_URL}/projects/${projectId}/settings?section=boards&create=board`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  const legacyCreateDialog = page.getByRole('dialog', { name: 'New board' })
  await legacyCreateDialog.waitFor()
  await legacyCreateDialog.getByRole('button', { name: 'Cancel' }).click()
  await legacyCreateDialog.waitFor({ state: 'hidden' })

  return waitForBoard(token, projectId, renamedBoardName)
}

const exerciseBoardManagementPhone = async ({ page, projectId, board }) => {
  await gotoBoardList(page, projectId)
  const newBoard = page.getByRole('button', { name: 'New board', exact: true })
  const row = boardListRow(page, board.name)
  const openBoard = row.getByRole('link', { name: 'Open board' })
  const settings = row.getByRole('link', { name: 'Settings' })
  const rowText = await row.innerText()
  assert.match(rowText, /Kanban/u, 'phone board row names its style')
  assert.match(rowText, /Default/u, 'phone board row names the default board')
  assert.match(rowText, /columns/u, 'phone board row names its column count')
  for (const [label, locator] of [['New board', newBoard], ['Open board', openBoard], ['Settings', settings]]) {
    const box = await locator.boundingBox()
    assert.ok(box, `${label} is visible on a phone`)
    assert.ok(box.height >= 44, `${label} keeps a 44px touch target (was ${box.height}px)`)
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `${label} stays within the phone viewport`)
  }
  const documentWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  assert.equal(documentWidth.scrollWidth, documentWidth.clientWidth, 'board list does not create page-wide horizontal scroll')

  await settings.click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=general$`, 'u'))
  await page.getByRole('button', { name: 'Back to boards', exact: true }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  await boardListRow(page, board.name).getByRole('link', { name: 'Settings' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=general$`, 'u'))
  const tabs = page.getByRole('tablist', { name: 'Board settings' })
  for (const name of ['General', 'Columns', 'Watchers']) {
    const tab = tabs.getByRole('tab', { name })
    const box = await tab.boundingBox()
    assert.ok(box, `${name} tab is visible on a phone`)
    assert.ok(box.height >= 44, `${name} tab keeps a 44px touch target (was ${box.height}px)`)
  }
  await tabs.getByRole('tab', { name: 'Watchers' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/${board.id}/settings\\?tab=watchers$`, 'u'))
  const recipientBox = await page.getByLabel('Tell').boundingBox()
  assert.ok(recipientBox, 'watcher recipient control is visible on a phone')
  assert.ok(recipientBox.height >= 44, `watcher recipient control is a touch target (was ${recipientBox.height}px)`)
  assert.ok(
    recipientBox.x >= 0 && recipientBox.x + recipientBox.width <= 390,
    'watcher recipient control stays within the phone viewport',
  )
}

const touchSwipe = async (page, { fromX, fromY, toX, toY = fromY }) => {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fromX, y: fromY }],
    })
    for (let step = 1; step <= 8; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{
          x: fromX + ((toX - fromX) * step) / 8,
          y: fromY + ((toY - fromY) * step) / 8,
        }],
      })
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await client.detach()
  }
}

const shot = async (page, name) => {
  if (process.env.PROJECT_USABILITY_SCREENSHOTS !== '1') return
  await mkdir(SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false })
}

const main = async () => {
  if (!databaseUrl()) skip('DATABASE_URL is not set')
  if (!(await reachable(`${API_URL}/api/health`))) skip(`API is not reachable at ${API_URL}`)
  if (!(await reachable(ADMIN_URL))) skip(`admin is not reachable at ${ADMIN_URL}`)

  const seed = await seedTeam({ output: () => '' })
  const boards = await call(`/api/projects/${seed.project.id}/boards`, { token: seed.token })
  const sourceBoard = boards.find((board) => board.isDefault) ?? boards[0]
  assert.ok(sourceBoard, 'the seeded project has a default board')

  const browser = await launchBrowser()
  const desktop = await openViewportContext(browser, { name: 'desktop', token: seed.token })
  const phone = await openViewportContext(browser, { name: 'phone', token: seed.token })
  const desktopPage = await desktop.newPage()
  const phonePage = await phone.newPage()
  const boardBName = `Isolation proof ${runId}`
  const boardA = await exerciseBoardManagement({
    page: desktopPage.page,
    projectId: seed.project.id,
    sourceBoard,
    token: seed.token,
  })
  await exerciseBoardManagementPhone({
    page: phonePage.page,
    projectId: seed.project.id,
    board: boardA,
  })
  const boardB = await api(`/api/projects/${seed.project.id}/boards`, {
    body: {
      copyColumnsFromBoardId: boardA.id,
      name: boardBName,
    },
    method: 'POST',
    token: seed.token,
  })
  const firstColumn = boardA.columns[0]
  const secondColumn = boardA.columns[1]
  const boardBFirstColumn = boardB.columns[0]
  assert.ok(firstColumn && secondColumn && boardBFirstColumn, 'the boards have lifecycle columns')
  const createdTitle = `QA flow ${runId}`
  const editedTitle = `QA edited ${runId}`
  const touchTitle = `QA touch ${runId}`
  const boardBTitle = `QA board B ${runId}`
  const touchTitles = [touchTitle, ...Array.from({ length: 7 }, (_, index) => `${touchTitle}-${index + 2}`)]
  const createdTaskIds = new Set()
  const cleanupFailures = []

  try {
    // Core lifecycle: browser owns creation and editing; the drop gesture owns
    // placement, then the real board read proves the persisted result.
    await goto(desktopPage.page, `/projects/${seed.project.id}/board?board=${boardA.id}`)
    await createTaskThroughUi(desktopPage.page, createdTitle, 'A durable browser flow')
    const createdTask = await waitForBoardTask(
      seed.token,
      seed.project.id,
      boardA.id,
      createdTitle,
      firstColumn.id,
    )
    createdTaskIds.add(createdTask.id)
    await editTaskThroughUi(desktopPage.page, createdTitle, editedTitle)
    await moveTaskThroughUi(desktopPage.page, editedTitle, secondColumn)
    const editedTask = await waitForBoardTask(
      seed.token,
      seed.project.id,
      boardA.id,
      editedTitle,
      secondColumn.id,
    )
    createdTaskIds.add(editedTask.id)
    await shot(desktopPage.page, 'desktop-lifecycle')

    // Board isolation: a sibling board has its own columns and ticket pool.
    await goto(desktopPage.page, `/projects/${seed.project.id}/board?board=${boardB.id}`)
    await desktopPage.page.locator('[data-kanban-card]').filter({ hasText: editedTitle }).waitFor({ state: 'detached' })
    assert.equal(
      await desktopPage.page.locator('[data-kanban-card]').filter({ hasText: editedTitle }).count(),
      0,
      'a ticket created on board A is absent from board B',
    )
    await createTaskThroughUi(desktopPage.page, boardBTitle)
    const boardBTask = await waitForBoardTask(
      seed.token,
      seed.project.id,
      boardB.id,
      boardBTitle,
      boardBFirstColumn.id,
    )
    createdTaskIds.add(boardBTask.id)
    await shot(desktopPage.page, 'desktop-isolated-board')

    // Phone doorway plus touch-sized board scrolling. This also checks the
    // production drag-handle contract without requiring a long-press drag.
    await goto(phonePage.page, `/projects/${seed.project.id}/board?board=${boardA.id}`)
    for (const title of touchTitles) {
      await createTaskThroughUi(phonePage.page, title)
      const task = await waitForBoardTask(seed.token, seed.project.id, boardA.id, title, firstColumn.id)
      createdTaskIds.add(task.id)
    }
    const viewport = phonePage.page.locator('[data-kanban-board-viewport]')
    const metrics = await viewport.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }))
    assert.ok(metrics.scrollWidth > metrics.clientWidth, 'a phone board exposes horizontal overflow for later columns')
    const card = phonePage.page.locator('[data-kanban-card]').filter({ hasText: touchTitle }).first()
    const handle = card.locator('[data-kanban-drag-handle]')
    assert.equal(await handle.count(), 1, 'a ticket card has one labelled drag handle')
    const handleBox = await handle.boundingBox()
    assert.ok(handleBox && handleBox.width >= 44 && handleBox.height >= 44, 'drag handle meets 44px touch target')
    const dropzone = phonePage.page.locator(`[data-kanban-dropzone="${firstColumn.id}"]`)
    const vertical = await dropzone.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }))
    assert.ok(vertical.scrollHeight > vertical.clientHeight, 'a populated column exposes vertical overflow')
    const beforeVertical = await dropzone.evaluate((node) => node.scrollTop)
    const cardBoxBeforeVertical = await card.boundingBox()
    assert.ok(cardBoxBeforeVertical, 'the touch test card body is visible before vertical paging')
    await touchSwipe(phonePage.page, {
      fromX: cardBoxBeforeVertical.x + cardBoxBeforeVertical.width / 3,
      fromY: cardBoxBeforeVertical.y + cardBoxBeforeVertical.height * 0.75,
      toX: cardBoxBeforeVertical.x + cardBoxBeforeVertical.width / 3,
      toY: cardBoxBeforeVertical.y + 12,
    })
    await phonePage.page.waitForTimeout(350)
    const afterVertical = await dropzone.evaluate((node) => node.scrollTop)
    assert.ok(afterVertical > beforeVertical, `column scrolls vertically (${beforeVertical} → ${afterVertical})`)
    await shot(phonePage.page, 'phone-before-board-scroll')
    const before = await viewport.evaluate((node) => node.scrollLeft)
    const viewportBox = await viewport.boundingBox()
    assert.ok(viewportBox, 'the phone board viewport has a measurable touch surface')
    const horizontalCard = phonePage.page.locator('[data-kanban-card]:visible').first()
    const horizontalCardBox = await horizontalCard.boundingBox()
    assert.ok(horizontalCardBox, 'a visible card body remains available for horizontal paging')
    await touchSwipe(phonePage.page, {
      fromX: horizontalCardBox.x + horizontalCardBox.width - 70,
      fromY: horizontalCardBox.y + horizontalCardBox.height / 2,
      toX: viewportBox.x + 20,
    })
    await phonePage.page.waitForTimeout(700)
    const after = await viewport.evaluate((node) => node.scrollLeft)
    assert.ok(after > before, `touch swipe pages the board (${before} → ${after})`)
    await shot(phonePage.page, 'phone-board-scroll')

    const switcher = phonePage.page.locator(`[data-testid="board-tab-${boardB.id}"]`)
    const boardTrigger = phonePage.page.locator('button.tabbar-trigger[aria-label="Boards"]')
    assert.ok(
      (await switcher.count()) === 1 || (await boardTrigger.count()) === 1,
      'the phone board switcher exposes the sibling board',
    )
    if (await switcher.count()) {
      await switcher.click()
    } else {
      await boardTrigger.click()
      await phonePage.page.locator('[role="listbox"][aria-label="Boards"]').getByRole('option', { name: boardB.name }).click()
    }
    await phonePage.page.waitForURL(new RegExp(`[?&]board=${boardB.id}(?:&|$)`, 'u'))
    await phonePage.page.waitForFunction(
      (title) => ![...document.querySelectorAll('[data-kanban-card]')]
        .some((card) => card.textContent?.includes(title)),
      touchTitle,
      { timeout: 30_000 },
    )
    assert.equal(
      await phonePage.page.locator('[data-kanban-card]').filter({ hasText: touchTitle }).count(),
      0,
      'switching to board B keeps board A tickets out of the phone view',
    )
    const destinationViewport = phonePage.page.locator('[data-kanban-board-viewport]')
    await destinationViewport.evaluate((node) => { node.scrollLeft = 0 })
    const destinationDropzone = phonePage.page.locator(`[data-kanban-dropzone="${boardBFirstColumn.id}"]`)
    await destinationDropzone.waitFor()
    const destinationCard = phonePage.page.locator('[data-kanban-card]').filter({ hasText: boardBTitle }).first()
    await destinationCard.waitFor()
    assert.ok(await destinationDropzone.isVisible(), 'board B first column is visible after switching')
    assert.ok(await destinationCard.isVisible(), 'board B own ticket is visible after switching')
    assert.equal(
      await phonePage.page.locator('[data-kanban-card]').filter({ hasText: boardBTitle }).count(),
      1,
      'switching to board B shows its own first-column ticket',
    )
    await shot(phonePage.page, 'phone-isolated-board')
  } finally {
    await desktopPage.close()
    await phonePage.close()
    await desktop.close()
    await phone.close()
    await browser.close()
    for (const taskId of createdTaskIds) {
      await api(`/api/tasks/${taskId}/transition`, {
        body: { status: 'cancelled' },
        method: 'POST',
        token: seed.token,
      }).catch((error) => cleanupFailures.push(`cancel task ${taskId}: ${error.message}`))
    }
    await api(`/api/projects/${seed.project.id}/boards/${boardB.id}`, {
      method: 'DELETE',
      token: seed.token,
    }).catch((error) => cleanupFailures.push(`delete board ${boardB.id}: ${error.message}`))
    await api(`/api/projects/${seed.project.id}/boards/${boardA.id}`, {
      method: 'DELETE',
      token: seed.token,
    }).catch((error) => cleanupFailures.push(`delete board ${boardA.id}: ${error.message}`))
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`project-usability cleanup failed:\n  ${cleanupFailures.join('\n  ')}`)
  }
  console.log('project-usability e2e: passed (lifecycle, isolation, phone touch scroll)')
}

await main()
