import assert from 'node:assert/strict'
import { openViewportContext } from '../navigation/lib/browser.mjs'

const boardPath = (projectId) => `/api/projects/${projectId}/boards`
const spacePath = '/api/knowledge-base/spaces'

const serverFailure = (route) => route.fulfill({
  body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: 'fixture failure' } }),
  contentType: 'application/json',
  status: 500,
})

/**
 * Uses a fresh query client so the failed initial reads cannot be satisfied by
 * another project-usability step. It proves both recovery paths and that a
 * project switch never paints the preceding board while its own read is held.
 */
export const exerciseProjectLoadFailures = async ({
  adminUrl,
  api,
  browser,
  destinationProject,
  project,
  runId,
  shot,
  sourceBoard,
  token,
}) => {
  const sourceTask = await api('/api/tasks', {
    body: { boardId: sourceBoard.id, projectId: project.id, title: `Load boundary ${runId}` },
    method: 'POST',
    token,
  })
  let failBoards = false
  let failSpaces = false
  let holdDestinationBoards = false
  let releaseDestinationBoards
  const routeRequest = async (route) => {
    const request = new URL(route.request().url())
    if (failBoards && request.pathname === boardPath(project.id)) return serverFailure(route)
    if (
      failSpaces
      && request.pathname === spacePath
      && request.searchParams.get('projectId') === project.id
    ) return serverFailure(route)
    if (holdDestinationBoards && request.pathname === boardPath(destinationProject.id)) {
      await new Promise((resolve) => { releaseDestinationBoards = resolve })
    }
    return route.continue()
  }
  const context = await openViewportContext(browser, { name: 'desktop', route: routeRequest, token })
  const target = await context.newPage()
  const { page } = target

  try {
    failBoards = true
    await page.goto(`${adminUrl}/projects/${project.id}/board`, { waitUntil: 'domcontentloaded' })
    const boardFailure = page.getByText('Failed to load boards.')
    await boardFailure.waitFor()
    await page.getByText("Couldn't load boards.").waitFor()
    assert.equal(
      await page.getByText('There are no boards yet.', { exact: true }).count(),
      0,
      'a failed board read does not claim the project has no boards in its sidebar doorway',
    )
    await boardFailure.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    await shot(page, 'desktop-project-board-load-failure')
    failBoards = false
    await boardFailure.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.locator('[data-kanban-board-viewport]').waitFor()
    await page.getByText(sourceTask.title, { exact: true }).waitFor()
    await shot(page, 'desktop-project-board-load-recovered')

    failSpaces = true
    await page.goto(`${adminUrl}/projects/${project.id}/docs`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Failed to load this project’s document spaces.').waitFor()
    assert.equal(
      await page.getByText('This project has no document spaces yet. Create one to file its docs here.', { exact: true }).count(),
      0,
      'a failed space read does not claim the project is empty',
    )
    await shot(page, 'desktop-project-docs-load-failure')
    failSpaces = false
    await page.getByText('Failed to load this project’s document spaces.').getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByText('This project has no document spaces yet. Create one to file its docs here.', { exact: true }).waitFor()
    await shot(page, 'desktop-project-docs-load-recovered')

    await page.goto(`${adminUrl}/projects/${project.id}/board?board=${sourceBoard.id}`, { waitUntil: 'domcontentloaded' })
    await page.getByText(sourceTask.title, { exact: true }).waitFor()
    holdDestinationBoards = true
    await page.getByRole('button', { name: `Expand ${destinationProject.name} sections` }).click()
    const destinationSections = page.locator(`[id$="-${destinationProject.id}-sections"]`)
    await destinationSections.waitFor()
    await destinationSections.locator(`a[href="/projects/${destinationProject.id}/boards"]`).click()
    await page.waitForFunction(
      (projectId) => window.location.pathname === `/projects/${projectId}/boards`,
      destinationProject.id,
    )
    await page.getByRole('button', { name: 'Back to board' }).click()
    await page.waitForFunction(
      (projectId) => window.location.pathname === `/projects/${projectId}/board`,
      destinationProject.id,
    )
    const destinationLayer = page
      .locator('[data-phone-navigation-layer="current"]')
      .filter({ hasText: 'Loading boards…' })
    await destinationLayer.waitFor()
    assert.equal(
      await destinationLayer.getByText(sourceTask.title, { exact: true }).count(),
      0,
      'the active destination never renders a prior project’s task while its own board read is pending',
    )
    assert.equal(
      await destinationLayer.locator('[data-kanban-board-viewport]').count(),
      0,
      'the active destination does not retain a prior project board during its own read',
    )
    await shot(page, 'desktop-project-destination-load-pending')
    releaseDestinationBoards?.()
    await page.locator('[data-kanban-board-viewport]').waitFor()
    holdDestinationBoards = false
  } finally {
    releaseDestinationBoards?.()
    await target.close()
    await context.close()
  }

  return sourceTask
}
