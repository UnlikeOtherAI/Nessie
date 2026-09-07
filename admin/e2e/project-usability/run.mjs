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
  await dialog.getByRole('button', { name: 'Create task' }).click()
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

const touchSwipe = async (page, { fromX, toX, y }) => {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fromX, y }],
    })
    for (let step = 1; step <= 8; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: fromX + ((toX - fromX) * step) / 8, y }],
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
  const boardA = await api(`/api/projects/${seed.project.id}/boards`, {
    body: {
      copyColumnsFromBoardId: sourceBoard.id,
      name: `Usability flow ${runId}`,
    },
    method: 'POST',
    token: seed.token,
  })
  const boardB = await api(`/api/projects/${seed.project.id}/boards`, {
    body: {
      copyColumnsFromBoardId: sourceBoard.id,
      name: `Isolation proof ${runId}`,
    },
    method: 'POST',
    token: seed.token,
  })
  const firstColumn = boardA.columns[0]
  const secondColumn = boardA.columns[1]
  assert.ok(firstColumn && secondColumn, 'the seeded board has at least two lifecycle columns')

  const browser = await launchBrowser()
  const desktop = await openViewportContext(browser, { name: 'desktop', token: seed.token })
  const phone = await openViewportContext(browser, { name: 'phone', token: seed.token })
  const desktopPage = await desktop.newPage()
  const phonePage = await phone.newPage()
  const createdTitle = `QA flow ${runId}`
  const editedTitle = `QA edited ${runId}`
  const touchTitle = `QA touch ${runId}`
  const touchTitles = [touchTitle, ...Array.from({ length: 7 }, (_, index) => `${touchTitle}-${index + 2}`)]
  const createdTaskIds = new Set()

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
    await dropzone.hover()
    await phonePage.page.mouse.wheel(0, 600)
    await phonePage.page.waitForTimeout(250)
    const afterVertical = await dropzone.evaluate((node) => node.scrollTop)
    assert.ok(afterVertical > beforeVertical, `column scrolls vertically (${beforeVertical} → ${afterVertical})`)
    await shot(phonePage.page, 'phone-before-board-scroll')
    const before = await viewport.evaluate((node) => node.scrollLeft)
    const viewportBox = await viewport.boundingBox()
    assert.ok(viewportBox, 'the phone board viewport has a measurable touch surface')
    await touchSwipe(phonePage.page, {
      fromX: viewportBox.x + viewportBox.width - 20,
      toX: viewportBox.x + 20,
      // Start below the card so the dnd sensor never interprets this paging
      // gesture as a long-press drag.
      y: viewportBox.y + viewportBox.height - 12,
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
      }).catch(() => undefined)
    }
    await api(`/api/projects/${seed.project.id}/boards/${boardB.id}`, {
      method: 'DELETE',
      token: seed.token,
    }).catch(() => undefined)
    await api(`/api/projects/${seed.project.id}/boards/${boardA.id}`, {
      method: 'DELETE',
      token: seed.token,
    }).catch(() => undefined)
  }

  console.log('project-usability e2e: passed (lifecycle, isolation, phone touch scroll)')
}

await main()
