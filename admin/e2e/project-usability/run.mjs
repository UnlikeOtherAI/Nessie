#!/usr/bin/env node
// Real-browser project management journey. It adopts the shared dev servers.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { ADMIN_PORT, API_URL, databaseUrl } from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam, call } from '../navigation/lib/seed.mjs'
import {
  exerciseBoardManagement,
  exerciseBoardManagementPhone,
  exerciseBoardManagementTablet,
} from './board-management.mjs'

const ADMIN_URL = `http://localhost:${ADMIN_PORT}`
const SCREENSHOTS = fileURLToPath(new URL('../../../e2e/screenshots/project-usability/', import.meta.url))
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const skip = (reason) => { console.log(`project-usability e2e: SKIPPED — ${reason}`); process.exit(0) }
const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    await response.arrayBuffer()
    return response.status < 500
  } catch { return false }
}
const api = async (path, { body, method = 'GET', token } = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
  if (await action.count()) await action.first().click()
  else { await page.getByRole('button', { name: 'More page actions' }).click(); await page.getByRole('menuitem', { name: 'New task' }).click() }
  return page.getByRole('dialog', { name: 'New task' })
}
const createTask = async (page, title, detail) => {
  const dialog = await openNewTask(page)
  await dialog.getByRole('textbox', { name: 'Title' }).fill(title)
  if (detail) await dialog.getByRole('textbox', { name: 'Detail' }).fill(detail)
  await dialog.getByRole('button', { name: 'Create task' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('[data-kanban-card]').filter({ hasText: title }).waitFor()
}
const editTask = async (page, title, editedTitle, column) => {
  await page.locator('[data-kanban-card]').filter({ hasText: title }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Task details' })
  if (editedTitle) await dialog.getByRole('textbox', { name: 'Title' }).fill(editedTitle)
  if (column) await dialog.getByLabel('Column').selectOption(column.id)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await dialog.waitFor({ state: 'hidden' })
}
const waitForBoardTask = async (token, projectId, boardId, title, expectedColumnId) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const task = (await api(`/api/projects/${projectId}/boards/${boardId}/tasks`, { token })).tasks.find((item) => item.title === title)
    if (task && (!expectedColumnId || task.columnId === expectedColumnId)) return task
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`board ${boardId} did not expose ${JSON.stringify(title)}`)
}
const touchSwipe = async (page, { fromX, fromY, toX, toY = fromY }) => {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] })
    for (let step = 1; step <= 8; step += 1) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + ((toX - fromX) * step) / 8, y: fromY + ((toY - fromY) * step) / 8 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally { await client.detach() }
}
const shot = async (page, name) => {
  if (process.env.PROJECT_USABILITY_SCREENSHOTS !== '1') return
  await mkdir(SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false })
}
const observeBrowserDiagnostics = (target) => {
  target.page.on('console', (message) => {
    if (message.type() === 'error') target.errors.push(`console: ${message.text()} (${message.location().url})`)
  })
}
const captureFailure = async (target, name) => {
  if (!target) return
  const { errors, page } = target
  console.error(`project-usability e2e: ${name} failed at ${page.url()}`)
  if (errors.length > 0) console.error(`project-usability e2e: ${name} browser errors:\n  ${errors.join('\n  ')}`)
  await mkdir(SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: `${SCREENSHOTS}/failure-${name}.png`, fullPage: false }).catch((error) => {
    console.error(`project-usability e2e: could not capture ${name}: ${error.message}`)
  })
}
const clearFixtureKnowledge = async (projectId, taskIds) => {
  const prisma = new PrismaClient()
  try {
    const [pages, spaces] = await Promise.all([
      prisma.knowledgePage.findMany({
        where: { projectId },
        select: { id: true, taskId: true },
      }),
      prisma.knowledgeSpace.findMany({
        where: { projectId },
        select: { id: true, name: true },
      }),
    ])
    const unexpectedPage = pages.find((page) => !page.taskId || !taskIds.has(page.taskId))
    const unexpectedSpace = spaces.find((space) => space.name !== 'Project Documents')
    if (unexpectedPage || unexpectedSpace) {
      throw new Error(`unexpected knowledge fixture: ${JSON.stringify({ unexpectedPage, unexpectedSpace })}`)
    }
    if (pages.length > 0) {
      await prisma.knowledgePage.deleteMany({ where: { id: { in: pages.map((page) => page.id) } } })
    }
    if (spaces.length > 0) {
      await prisma.knowledgeSpace.deleteMany({ where: { id: { in: spaces.map((space) => space.id) } } })
    }
  } finally {
    await prisma.$disconnect()
  }
}

const main = async () => {
  if (!databaseUrl()) skip('DATABASE_URL is not set')
  if (!(await reachable(`${API_URL}/api/health`))) skip(`API is not reachable at ${API_URL}`)
  if (!(await reachable(ADMIN_URL))) skip(`admin is not reachable at ${ADMIN_URL}`)
  const seed = await seedTeam({ output: () => '' })
  const cleanupFailures = []
  const createdTaskIds = new Set()
  let browser; let desktop; let phone; let tablet; let desktopPage; let phonePage; let tabletPage
  let project; let sourceBoard; let boardAId; let boardBId
  try {
    project = await api('/api/projects', { body: { name: `Project usability ${runId}` }, method: 'POST', token: seed.token })
    const boards = await call(`/api/projects/${project.id}/boards`, { token: seed.token })
    sourceBoard = boards.find((board) => board.isDefault) ?? boards[0]
    assert.ok(sourceBoard, 'the disposable project has a default board')
    browser = await launchBrowser()
    desktop = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    phone = await openViewportContext(browser, { name: 'phone', token: seed.token })
    tablet = await openViewportContext(browser, { name: 'tablet', token: seed.token })
    desktopPage = await desktop.newPage(); phonePage = await phone.newPage(); tabletPage = await tablet.newPage()
    observeBrowserDiagnostics(desktopPage); observeBrowserDiagnostics(phonePage); observeBrowserDiagnostics(tabletPage)
    const boardA = await exerciseBoardManagement({
      adminUrl: ADMIN_URL, api, call, onBoardCreated: (id) => { boardAId = id }, page: desktopPage.page,
      projectId: project.id, runId, shot, sourceBoard, token: seed.token,
    })
    await exerciseBoardManagementPhone({
      adminUrl: ADMIN_URL, board: boardA, page: phonePage.page, projectId: project.id, shot,
    })
    await exerciseBoardManagementTablet({
      adminUrl: ADMIN_URL, board: boardA, page: tabletPage.page, projectId: project.id, shot,
    })
    const boardB = await api(`/api/projects/${project.id}/boards`, { body: { copyColumnsFromBoardId: boardA.id, name: `Isolation proof ${runId}` }, method: 'POST', token: seed.token })
    boardBId = boardB.id
    const [firstColumn, secondColumn, boardBFirstColumn] = [boardA.columns[0], boardA.columns[1], boardB.columns[0]]
    assert.ok(firstColumn && secondColumn && boardBFirstColumn, 'the boards have lifecycle columns')
    const createdTitle = `QA flow ${runId}`; const editedTitle = `QA edited ${runId}`; const touchTitle = `QA touch ${runId}`; const boardBTitle = `QA board B ${runId}`
    await goto(desktopPage.page, `/projects/${project.id}/board?board=${boardA.id}`)
    await createTask(desktopPage.page, createdTitle, 'A durable browser flow')
    createdTaskIds.add((await waitForBoardTask(seed.token, project.id, boardA.id, createdTitle, firstColumn.id)).id)
    await editTask(desktopPage.page, createdTitle, editedTitle, secondColumn)
    createdTaskIds.add((await waitForBoardTask(seed.token, project.id, boardA.id, editedTitle, secondColumn.id)).id)
    await shot(desktopPage.page, 'desktop-lifecycle')
    await goto(desktopPage.page, `/projects/${project.id}/board?board=${boardB.id}`)
    await desktopPage.page.locator('[data-kanban-card]').filter({ hasText: editedTitle }).waitFor({ state: 'detached' })
    assert.equal(await desktopPage.page.locator('[data-kanban-card]').filter({ hasText: editedTitle }).count(), 0, 'board B excludes board A work')
    await createTask(desktopPage.page, boardBTitle)
    createdTaskIds.add((await waitForBoardTask(
      seed.token, project.id, boardB.id, boardBTitle, boardBFirstColumn.id,
    )).id)
    await shot(desktopPage.page, 'desktop-isolated-board')
    await goto(phonePage.page, `/projects/${project.id}/board?board=${boardA.id}`)
    const touchTitles = [touchTitle, ...Array.from({ length: 7 }, (_, index) => `${touchTitle}-${index + 2}`)]
    for (const title of touchTitles) {
      await createTask(phonePage.page, title)
      createdTaskIds.add((await waitForBoardTask(
        seed.token, project.id, boardA.id, title, firstColumn.id,
      )).id)
    }
    const viewport = phonePage.page.locator('[data-kanban-board-viewport]')
    const metrics = await viewport.evaluate((node) => ({
      clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
    }))
    assert.ok(metrics.scrollWidth > metrics.clientWidth, 'a phone board exposes horizontal overflow')
    const card = phonePage.page.locator('[data-kanban-card]').filter({ hasText: touchTitle }).first()
    const handle = card.locator('[data-kanban-drag-handle]')
    const handleBox = await handle.boundingBox()
    assert.ok(handleBox && handleBox.width >= 44 && handleBox.height >= 44, 'drag handle meets 44px touch target')
    const dropzone = phonePage.page.locator(`[data-kanban-dropzone="${firstColumn.id}"]`)
    const beforeVertical = await dropzone.evaluate((node) => node.scrollTop)
    const cardBox = await card.boundingBox(); assert.ok(cardBox, 'card is visible before vertical paging')
    await touchSwipe(phonePage.page, {
      fromX: cardBox.x + cardBox.width / 3, fromY: cardBox.y + cardBox.height * 0.75,
      toX: cardBox.x + cardBox.width / 3, toY: cardBox.y + 12,
    })
    await phonePage.page.waitForTimeout(350)
    assert.ok(await dropzone.evaluate((node) => node.scrollTop) > beforeVertical, 'column scrolls vertically')
    const before = await viewport.evaluate((node) => node.scrollLeft); const viewportBox = await viewport.boundingBox(); assert.ok(viewportBox, 'board viewport is measurable')
    const horizontalCardBox = await phonePage.page.locator('[data-kanban-card]:visible').first().boundingBox(); assert.ok(horizontalCardBox, 'card is available for horizontal paging')
    await touchSwipe(phonePage.page, {
      fromX: horizontalCardBox.x + horizontalCardBox.width - 70,
      fromY: horizontalCardBox.y + horizontalCardBox.height / 2, toX: viewportBox.x + 20,
    })
    await phonePage.page.waitForTimeout(700)
    assert.ok(await viewport.evaluate((node) => node.scrollLeft) > before, 'touch swipe pages the board')
    await shot(phonePage.page, 'phone-board-scroll')
    const switcher = phonePage.page.locator(`[data-testid="board-tab-${boardB.id}"]`)
    const boardTrigger = phonePage.page.locator('button.tabbar-trigger[aria-label="Boards"]')
    assert.ok((await switcher.count()) === 1 || (await boardTrigger.count()) === 1, 'phone board switcher exposes sibling board')
    if (await switcher.count()) await switcher.click()
    else { await boardTrigger.click(); await phonePage.page.locator('[role="listbox"][aria-label="Boards"]').getByRole('option', { name: boardB.name }).click() }
    await phonePage.page.waitForURL(new RegExp(`[?&]board=${boardB.id}(?:&|$)`, 'u'))
    await phonePage.page.waitForFunction((title) => ![...document.querySelectorAll('[data-kanban-card]')].some((item) => item.textContent?.includes(title)), touchTitle, { timeout: 30_000 })
    assert.equal(await phonePage.page.locator('[data-kanban-card]').filter({ hasText: touchTitle }).count(), 0, 'board B excludes board A phone work')
    await shot(phonePage.page, 'phone-isolated-board')
  } catch (error) {
    await captureFailure(desktopPage, 'desktop')
    await captureFailure(phonePage, 'phone')
    await captureFailure(tabletPage, 'tablet')
    throw error
  } finally {
    await desktopPage?.close().catch(() => {})
    await phonePage?.close().catch(() => {})
    await tabletPage?.close().catch(() => {})
    await desktop?.close().catch(() => {})
    await phone?.close().catch(() => {})
    await tablet?.close().catch(() => {})
    await browser?.close().catch(() => {})
    for (const taskId of createdTaskIds) await api(`/api/tasks/${taskId}/transition`, { body: { status: 'cancelled' }, method: 'POST', token: seed.token }).catch((error) => cleanupFailures.push(`cancel task ${taskId}: ${error.message}`))
    if (sourceBoard && boardAId) await api(`/api/projects/${project.id}/boards/${sourceBoard.id}`, { body: { isDefault: true }, method: 'PATCH', token: seed.token }).catch((error) => cleanupFailures.push(`restore default board: ${error.message}`))
    for (const boardId of [boardBId, boardAId]) if (boardId) await api(`/api/projects/${project.id}/boards/${boardId}?newDefaultBoardId=${sourceBoard.id}`, { method: 'DELETE', token: seed.token }).catch((error) => cleanupFailures.push(`delete board ${boardId}: ${error.message}`))
    if (project) await clearFixtureKnowledge(project.id, createdTaskIds).catch((error) => cleanupFailures.push(`delete fixture knowledge: ${error.message}`))
    if (project) await api(`/api/projects/${project.id}`, { method: 'DELETE', token: seed.token }).catch((error) => cleanupFailures.push(`delete disposable project: ${error.message}`))
  }
  if (cleanupFailures.length > 0) throw new Error(`project-usability cleanup failed:\n  ${cleanupFailures.join('\n  ')}`)
  console.log('project-usability e2e: passed (board management, lifecycle, isolation, phone touch scroll)')
}

await main()
