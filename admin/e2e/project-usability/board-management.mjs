import assert from 'node:assert/strict'

const sleep = () => new Promise((resolve) => setTimeout(resolve, 250))

const gotoBoardList = async (page, adminUrl, projectId) => {
  await page.goto(`${adminUrl}/projects/${projectId}/boards`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Boards', exact: true }).waitFor({ timeout: 60_000 })
  await page.getByRole('table', { name: 'Project boards' }).waitFor({ timeout: 60_000 })
}

const boardListRow = (page, name) => page.locator('tbody').getByRole('row').filter({ hasText: name })

const waitForSettings = async (page, projectId, boardId, tab) => {
  const pathname = `/projects/${projectId}/boards/${boardId}/settings`
  if (tab !== 'general') {
    await page.waitForURL(new RegExp(`${pathname}\\?tab=${tab}$`, 'u'))
    return
  }
  await page.waitForFunction((expectedPathname) => {
    const url = new URL(window.location.href)
    return url.pathname === expectedPathname && [null, 'general'].includes(url.searchParams.get('tab'))
  }, pathname)
}

const waitForBoard = async (call, token, projectId, name, expected = {}) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const boards = await call(`/api/projects/${projectId}/boards`, { token })
    const board = boards.find((item) => item.name === name)
    if (board && Object.entries(expected).every(([key, value]) => board[key] === value)) return board
    await sleep()
  }
  throw new Error(`board ${JSON.stringify(name)} did not reach ${JSON.stringify(expected)}`)
}

const waitForBoardColumn = async (call, token, projectId, boardName, columnName) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const board = await waitForBoard(call, token, projectId, boardName)
    if (board.columns.some((column) => column.name === columnName)) return board
    await sleep()
  }
  throw new Error(`board ${JSON.stringify(boardName)} did not persist column ${JSON.stringify(columnName)}`)
}

const waitForWatcher = async (api, token, projectId, boardId, recipientId) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const watchers = await api(`/api/projects/${projectId}/boards/${boardId}/watchers`, { token })
    if (watchers.some((watcher) => watcher.recipientId === recipientId)) return
    await sleep()
  }
  throw new Error(`board ${boardId} did not save watcher ${recipientId}`)
}

const createBoardThroughUi = async ({ adminUrl, onCreated, page, projectId, sourceBoardId, name }) => {
  await gotoBoardList(page, adminUrl, projectId)
  await page.locator('[data-page-header-action="new-board"]:visible').click()
  const dialog = page.getByRole('dialog', { name: 'New board' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByLabel('Starting columns').selectOption(sourceBoardId)
  const create = dialog.getByRole('button', { name: 'Create board' })
  assert.ok(await create.isVisible(), 'New board keeps its primary Create board action visible')
  await create.click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards/[^/]+/settings(?:\\?tab=general)?$`, 'u'))
  const boardId = new URL(page.url()).pathname.match(new RegExp(`/projects/${projectId}/boards/([^/]+)/settings$`, 'u'))?.[1]
  if (!boardId) throw new Error('new board route did not contain its board id')
  onCreated(decodeURIComponent(boardId))
  return decodeURIComponent(boardId)
}

/** Drives the discoverable list, create dialog, board settings and legacy links. */
export const exerciseBoardManagement = async ({
  adminUrl,
  api,
  call,
  onBoardCreated,
  page,
  projectId,
  runId,
  shot,
  sourceBoard,
  token,
}) => {
  const boardName = `Managed board ${runId}`
  const renamedBoardName = `Managed board renamed ${runId}`
  const columnName = `Ready for review ${runId}`
  const me = await api('/api/auth/me', { token })
  const watcherName = me.user.displayName

  await gotoBoardList(page, adminUrl, projectId)
  const table = page.getByRole('table', { name: 'Project boards' })
  const sourceRow = boardListRow(page, sourceBoard.name)
  await sourceRow.waitFor()
  assert.match(await sourceRow.first().innerText(), /Kanban|Iterations/u, 'board list names the board style')
  assert.match(await sourceRow.first().innerText(), /columns/u, 'board list names the column count')
  assert.match(await sourceRow.first().innerText(), /Default/u, 'board list names the default board')
  assert.ok(await table.getByRole('link', { name: 'Open board' }).count() > 0, 'each board has an Open board doorway')
  assert.ok(await table.getByRole('link', { name: 'Settings' }).count() > 0, 'each board has a Settings doorway')
  await shot(page, 'desktop-board-management-list')

  const createdBoardId = await createBoardThroughUi({
    adminUrl,
    name: boardName,
    onCreated: onBoardCreated,
    page,
    projectId,
    sourceBoardId: sourceBoard.id,
  })
  const board = await waitForBoard(call, token, projectId, boardName)
  assert.equal(board.id, createdBoardId, 'creation identifies the board it just made')
  const landedUrl = new URL(page.url())
  assert.equal(landedUrl.pathname, `/projects/${projectId}/boards/${board.id}/settings`, 'creation lands on the new board settings')
  assert.ok([null, 'general'].includes(landedUrl.searchParams.get('tab')), 'creation lands on General settings')
  await page.getByRole('heading', { name: boardName, exact: true }).waitFor()
  const settingsTabs = page.getByRole('tablist', { name: 'Board settings' })
  assert.equal(await settingsTabs.getByRole('tab', { name: 'General' }).getAttribute('aria-selected'), 'true', 'general is selected after creation')
  await shot(page, 'desktop-board-management-general')

  await gotoBoardList(page, adminUrl, projectId)
  await boardListRow(page, boardName).getByRole('link', { name: 'Open board' }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/board\\?board=${board.id}$`, 'u'))
  await page.waitForSelector('[data-kanban-board-viewport]', { timeout: 60_000 })
  await page.goBack()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))

  await boardListRow(page, boardName).getByRole('link', { name: 'Settings' }).click()
  await waitForSettings(page, projectId, board.id, 'general')
  const nameField = page.getByLabel('Board name')
  await nameField.fill(renamedBoardName)
  await nameField.blur()
  await waitForBoard(call, token, projectId, renamedBoardName)
  const style = page.getByLabel('Board style')
  await style.selectOption('scrum')
  await waitForBoard(call, token, projectId, renamedBoardName, { style: 'scrum' })
  await style.selectOption('kanban')
  await waitForBoard(call, token, projectId, renamedBoardName, { style: 'kanban' })
  await page.getByRole('button', { name: 'Make default', exact: true }).click()
  await waitForBoard(call, token, projectId, renamedBoardName, { isDefault: true })

  await settingsTabs.getByRole('tab', { name: 'Columns' }).click()
  await waitForSettings(page, projectId, board.id, 'columns')
  const generalName = page.getByLabel('Board name')
  await generalName.waitFor({ state: 'hidden' })
  assert.equal(await generalName.count(), 0, 'Columns does not retain General controls')
  await page.getByLabel('New column name').fill(columnName)
  await page.getByRole('button', { name: 'Add column' }).click()
  await waitForBoardColumn(call, token, projectId, renamedBoardName, columnName)

  await settingsTabs.getByRole('tab', { name: 'Watchers' }).click()
  await waitForSettings(page, projectId, board.id, 'watchers')
  const newColumnName = page.getByLabel('New column name')
  await newColumnName.waitFor({ state: 'hidden' })
  assert.equal(await newColumnName.count(), 0, 'Watchers does not retain Columns controls')
  const recipients = page.getByLabel('Tell')
  await recipients.fill(watcherName)
  await page.getByRole('button', { name: watcherName, exact: true }).click()
  await page.getByRole('button', { name: 'Save watchers' }).click()
  await waitForWatcher(api, token, projectId, board.id, me.user.id)

  await gotoBoardList(page, adminUrl, projectId)
  await boardListRow(page, renamedBoardName).getByRole('link', { name: 'Settings' }).click()
  await waitForSettings(page, projectId, board.id, 'general')
  await page.goBack()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  await page.goto(`${adminUrl}/projects/${projectId}/boards/${board.id}/settings?tab=watchers`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: renamedBoardName, exact: true }).waitFor()
  assert.equal(await settingsTabs.getByRole('tab', { name: 'Watchers' }).getAttribute('aria-selected'), 'true', 'a settings deep link selects its stated tab')

  await page.goto(`${adminUrl}/projects/${projectId}/settings?section=boards&board=${board.id}`, { waitUntil: 'domcontentloaded' })
  await waitForSettings(page, projectId, board.id, 'general')
  await page.goto(`${adminUrl}/projects/${projectId}/settings?section=boards&create=board`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  const legacyCreateDialog = page.getByRole('dialog', { name: 'New board' })
  await legacyCreateDialog.waitFor()
  await legacyCreateDialog.getByRole('button', { name: 'Cancel' }).click()
  await legacyCreateDialog.waitFor({ state: 'hidden' })

  return waitForBoard(call, token, projectId, renamedBoardName)
}

/** Keeps both board doorways reachable when the tablet shell leaves a narrow content pane. */
export const exerciseBoardManagementTablet = async ({ adminUrl, board, page, projectId, shot }) => {
  await gotoBoardList(page, adminUrl, projectId)
  const row = boardListRow(page, board.name)
  const tableBox = await page.getByRole('table', { name: 'Project boards' }).boundingBox()
  assert.ok(tableBox, 'tablet board table is visible')
  const actions = [
    ['Open board', row.getByRole('link', { name: 'Open board' })],
    ['Settings', row.getByRole('link', { name: 'Settings' })],
  ]
  const actionBoxes = []
  for (const [label, locator] of actions) {
    const box = await locator.boundingBox()
    assert.ok(box, `${label} is visible on a tablet`)
    assert.ok(box.height >= 44, `${label} keeps a 44px touch target (was ${box.height}px)`)
    assert.ok(
      box.x >= tableBox.x && box.x + box.width <= tableBox.x + tableBox.width,
      `${label} stays within the tablet table`,
    )
    actionBoxes.push(box)
  }
  const [openBoard, settings] = actionBoxes
  assert.ok(
    openBoard.y + openBoard.height <= settings.y || settings.y + settings.height <= openBoard.y,
    'tablet board actions do not overlap',
  )
  await shot(page, 'tablet-board-management-list')
}

/** Checks the management surface remains usable without horizontal panning at phone width. */
export const exerciseBoardManagementPhone = async ({ adminUrl, board, page, projectId, shot }) => {
  await gotoBoardList(page, adminUrl, projectId)
  const newBoard = page.locator('[data-page-header-action="new-board"]:visible')
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
  await shot(page, 'phone-board-management-list')

  await settings.click()
  await waitForSettings(page, projectId, board.id, 'general')
  await page.getByRole('button', { name: 'Back to boards', exact: true }).click()
  await page.waitForURL(new RegExp(`/projects/${projectId}/boards$`, 'u'))
  await boardListRow(page, board.name).getByRole('link', { name: 'Settings' }).click()
  await waitForSettings(page, projectId, board.id, 'general')
  const tabs = page.getByRole('tablist', { name: 'Board settings' })
  for (const name of ['General', 'Columns', 'Watchers']) {
    const box = await tabs.getByRole('tab', { name }).boundingBox()
    assert.ok(box, `${name} tab is visible on a phone`)
    assert.ok(box.height >= 44, `${name} tab keeps a 44px touch target (was ${box.height}px)`)
  }
  await tabs.getByRole('tab', { name: 'Watchers' }).click()
  await waitForSettings(page, projectId, board.id, 'watchers')
  const recipientBox = await page.getByLabel('Tell').boundingBox()
  assert.ok(recipientBox, 'watcher recipient control is visible on a phone')
  assert.ok(recipientBox.height >= 44, `watcher recipient control is a touch target (was ${recipientBox.height}px)`)
  assert.ok(recipientBox.x >= 0 && recipientBox.x + recipientBox.width <= 390, 'watcher recipient control stays within the phone viewport')
  await shot(page, 'phone-board-management-watchers')
}
