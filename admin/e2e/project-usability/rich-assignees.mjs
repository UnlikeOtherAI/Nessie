import assert from 'node:assert/strict'

const FIXTURE_USER_ID = '00000000-0000-4000-8000-000000000011'
const FIXTURE_REMOTE_TASK_ID = '00000000-0000-4000-8000-000000000012'
const FIXTURE_UNASSIGNED_TASK_ID = '00000000-0000-4000-8000-000000000013'
const FIXTURE_SOURCE_ID = '00000000-0000-4000-8000-000000000014'
const REMOTE_NAME = 'Riley Remote fixture'
const REMOTE_TITLE = 'Remote fixture card'
const USER_TITLE = 'Assigned fixture card'
const UNASSIGNED_TITLE = 'Unassigned fixture card'

const fixturePeople = (viewer) => [
  { displayName: viewer.displayName, id: viewer.id },
  ...Array.from({ length: 12 }, (_, index) => ({
    displayName: `Fixture colleague ${index + 1}`,
    id: `00000000-0000-4000-8000-${String(index + 21).padStart(12, '0')}`,
  })),
]

const fixtureTask = ({ board, id, projectId, title, viewer }) => ({
  agentId: null,
  archivedAt: null,
  assigneeAgentId: null,
  assigneeName: viewer ? viewer.displayName : null,
  assigneeUserId: viewer?.id ?? null,
  boardId: board.id,
  columnId: board.columns[0].id,
  createdAt: '2026-09-07T00:00:00.000Z',
  createdByUserId: viewer?.id ?? null,
  detail: null,
  dueDate: null,
  externalLink: null,
  fieldValues: {},
  id,
  iterationId: null,
  organizationId: '00000000-0000-4000-8000-000000000015',
  ownerName: viewer?.displayName ?? null,
  ownerUserId: viewer?.id ?? null,
  parentTaskId: null,
  position: 0,
  priority: 'medium',
  projectId,
  purpose: null,
  runId: null,
  status: 'inbox',
  storyPoints: null,
  title,
  updatedAt: '2026-09-07T00:00:00.000Z',
})

const boardFixture = ({ board, projectId, viewer }) => {
  const assigned = fixtureTask({
    board, id: FIXTURE_USER_ID, projectId, title: USER_TITLE, viewer,
  })
  const remote = {
    ...fixtureTask({
      board, id: FIXTURE_REMOTE_TASK_ID, projectId, title: REMOTE_TITLE,
    }),
    externalLink: {
      externalKey: 'LIN-42',
      externalUrl: 'https://linear.app/fixture/issue/LIN-42',
      lastInboundAt: null,
      provider: 'linear',
      remoteAssigneeDisplay: REMOTE_NAME,
      remoteAssigneeExternalId: 'riley-remote-fixture',
      remoteStateName: null,
      sourceId: FIXTURE_SOURCE_ID,
      writeMode: 'read_only',
    },
  }
  const unassigned = fixtureTask({
    board, id: FIXTURE_UNASSIGNED_TASK_ID, projectId, title: UNASSIGNED_TITLE,
  })
  return { people: fixturePeople(viewer), tasks: [assigned, remote, unassigned] }
}

const installFixture = async ({ board, page, projectId, viewer }) => {
  const fixture = boardFixture({ board, projectId, viewer })
  const context = page.context()
  const avatarRequests = []
  const assigneesRoute = async (route) => route.fulfill({
    body: JSON.stringify({ data: fixture.people }),
    contentType: 'application/json',
  })
  const tasksRoute = async (route) => route.fulfill({
    body: JSON.stringify({ data: { tasks: fixture.tasks, truncated: false } }),
    contentType: 'application/json',
  })
  const avatarsRoute = async (route) => {
    avatarRequests.push(route.request().url())
    await route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#345"/></svg>',
      contentType: 'image/svg+xml',
    })
  }
  const assigneesPath = '**/api/tasks/assignees'
  const tasksPath = `**/api/projects/${projectId}/boards/${board.id}/tasks`
  const avatarsPath = '**/api/users/*/avatar'
  await context.route(assigneesPath, assigneesRoute)
  await context.route(tasksPath, tasksRoute)
  await context.route(avatarsPath, avatarsRoute)
  return {
    avatarRequests,
    dispose: async () => {
      await context.unroute(avatarsPath, avatarsRoute)
      await context.unroute(tasksPath, tasksRoute)
      await context.unroute(assigneesPath, assigneesRoute)
    },
  }
}

const waitForBoard = async ({ adminUrl, board, page, projectId }) => {
  await page.goto(`${adminUrl}/projects/${projectId}/board?board=${board.id}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('[data-kanban-card]').filter({ hasText: REMOTE_TITLE }).waitFor({ timeout: 60_000 })
}

const selectedFilter = (page) => page.waitForFunction(() =>
  new URL(window.location.href).searchParams.get('assignee') === 'remote:linear:riley-remote-fixture')

const waitForTriggerFocus = (page) => page.waitForFunction(() =>
  document.activeElement?.getAttribute('aria-label') === 'Filter board by assignee')

const assigneeDialog = (page) =>
  page.getByRole('dialog', { name: 'Filter board by assignee', exact: true })

const assigneeSearch = (page) =>
  assigneeDialog(page).getByRole('combobox', { name: 'Search assignees', exact: true })

const checkAvatarOption = async ({ avatarRequests, listbox, viewer }) => {
  const option = listbox.getByRole('option', { name: viewer.displayName, exact: true })
  await option.getByAltText(viewer.displayName, { exact: true }).waitFor()
  assert.ok(avatarRequests.length > 0, 'the shared user avatar relay was requested')
}

/** Exercises rich board assignee choices against local responses only. */
export const exerciseRichBoardAssignees = async ({
  adminUrl,
  board,
  page,
  projectId,
  shot,
  viewer,
}) => {
  const installed = await installFixture({ board, page, projectId, viewer })
  try {
    await waitForBoard({ adminUrl, board, page, projectId })
    const trigger = page.getByRole('button', { name: 'Filter board by assignee', exact: true })
    await trigger.click()
    const listbox = page.getByRole('listbox', { name: 'Filter board by assignee', exact: true })
    await listbox.waitFor()
    await checkAvatarOption({ avatarRequests: installed.avatarRequests, listbox, viewer })
    const remoteOption = listbox.getByRole('option', { name: new RegExp(REMOTE_NAME, 'u') })
    assert.equal(await listbox.getByRole('group', { name: 'Not mapped' }).count(), 1, 'remote people have their own Not mapped group')
    assert.match(await remoteOption.innerText(), /Not mapped.*Linear/u, 'remote option names its mapping state and provider')
    assert.equal(await remoteOption.locator('svg[data-icon="user-slash"]').count(), 1, 'remote option uses the unmapped-person icon')

    const search = assigneeSearch(page)
    await search.fill('no fixture person has this name')
    await page.getByText('No matching people.', { exact: true }).waitFor()
    assert.equal(await listbox.getByRole('option').count(), 0, 'search hides choices that do not match')
    await search.press('Escape')
    await listbox.waitFor({ state: 'hidden' })
    await waitForTriggerFocus(page)

    await trigger.focus()
    await trigger.press('ArrowDown')
    await listbox.waitFor()
    const keyboardSearch = assigneeSearch(page)
    await keyboardSearch.fill(viewer.displayName)
    await keyboardSearch.press('Enter')
    await page.waitForFunction((userId) =>
      new URL(window.location.href).searchParams.get('assignee') === `user:${userId}`, viewer.id)
    await listbox.waitFor({ state: 'hidden' })
    await waitForTriggerFocus(page)
    await trigger.getByAltText(viewer.displayName, { exact: true }).waitFor()

    await trigger.click()
    await listbox.waitFor()
    const remoteSearch = assigneeSearch(page)
    await remoteSearch.fill(REMOTE_NAME)
    assert.equal(
      await remoteSearch.evaluate((input) => document.activeElement === input),
      true,
      'a reopened search keeps focus before Enter',
    )
    await remoteSearch.press('Enter')
    await selectedFilter(page)
    await listbox.waitFor({ state: 'hidden' })
    await waitForTriggerFocus(page)
    assert.equal(await trigger.innerText(), REMOTE_NAME, 'selected remote person stays named in the trigger')
    assert.equal(await trigger.locator('[title]').getAttribute('title'), REMOTE_NAME, 'selected remote person exposes their full name')
    assert.equal(await trigger.locator('svg[data-icon="user-slash"]').count(), 1, 'selected remote person keeps the unmapped-person icon')
    const remoteCard = page.locator('[data-kanban-card]').filter({ hasText: REMOTE_TITLE })
    await remoteCard.waitFor()
    assert.equal(await remoteCard.locator('svg[data-icon="user-slash"]').count(), 1, 'remote card keeps its unmapped-person icon')
    assert.equal(await page.locator('[data-kanban-card]').filter({ hasText: USER_TITLE }).count(), 0, 'remote filter hides user-assigned cards')
    assert.equal(await page.locator('[data-kanban-card]').filter({ hasText: UNASSIGNED_TITLE }).count(), 0, 'remote filter hides unassigned cards')
    await shot(page, 'desktop-rich-board-assignees-selected')

    await trigger.click()
    const selectedRemoteOption = listbox.getByRole('option', { name: new RegExp(REMOTE_NAME, 'u') })
    await selectedRemoteOption.waitFor()
    assert.equal(await selectedRemoteOption.getAttribute('aria-selected'), 'true', 'the selected remote option stays enabled and selected')
    await selectedRemoteOption.click()
  } finally {
    await installed.dispose()
  }
}

/** Keeps the rich listbox’s touch-sized choices inside the phone viewport. */
export const exerciseRichBoardAssigneesPhone = async ({
  adminUrl,
  board,
  page,
  projectId,
  shot,
  viewer,
}) => {
  const installed = await installFixture({ board, page, projectId, viewer })
  try {
    await waitForBoard({ adminUrl, board, page, projectId })
    const trigger = page.getByRole('button', { name: 'Filter board by assignee', exact: true })
    const triggerBox = await trigger.boundingBox()
    assert.ok(triggerBox && triggerBox.height >= 44, 'phone assignee trigger keeps a 44px touch target')
    assert.ok(triggerBox && triggerBox.x >= 0 && triggerBox.x + triggerBox.width <= 390, 'phone assignee trigger stays in the viewport')
    await trigger.click()
    const listbox = page.getByRole('listbox', { name: 'Filter board by assignee', exact: true })
    await listbox.waitFor()
    const dialog = assigneeDialog(page)
    const dialogBox = await dialog.boundingBox()
    const listboxBox = await listbox.boundingBox()
    const viewport = page.viewportSize()
    assert.ok(
      dialogBox
        && viewport
        && dialogBox.x >= 0
        && dialogBox.y >= 0
        && dialogBox.x + dialogBox.width <= viewport.width
        && dialogBox.y + dialogBox.height <= viewport.height,
      'phone assignee popup stays in the viewport',
    )
    const options = listbox.getByRole('option')
    for (const option of [options.first(), options.last()]) {
      const optionBox = await option.boundingBox()
      assert.ok(optionBox && optionBox.height >= 44, 'phone assignee options keep 44px touch targets')
    }
    const menu = options.first().locator('..')
    const before = await menu.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    }))
    assert.ok(before.scrollHeight > before.clientHeight, 'phone assignee options use a scrollable menu')
    await menu.hover()
    await page.mouse.wheel(0, 400)
    await page.waitForFunction((node) => node.scrollTop > 0, await menu.elementHandle())
    const lastOptionBox = await options.last().boundingBox()
    assert.ok(
      listboxBox
        && lastOptionBox
        && lastOptionBox.y >= listboxBox.y
        && lastOptionBox.y + lastOptionBox.height <= listboxBox.y + listboxBox.height,
      'phone assignee menu scroll reaches its last option without clipping it',
    )
    await shot(page, 'phone-rich-board-assignees')
  } finally {
    await installed.dispose()
  }
}
