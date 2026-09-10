import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { openViewportContext } from '../navigation/lib/browser.mjs'

const waitFor = async (probe, message) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(message)
}

const refreshPermission = async (page) => {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('visibilitychange'))
  })
}

const setProjectRole = async (projectId, userId, role) => {
  const prisma = new PrismaClient()
  try {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { role },
    })
  } finally {
    await prisma.$disconnect()
  }
}

const deleteFixtureUser = async (userId) => {
  const prisma = new PrismaClient()
  try {
    // Creating the browser user provisions private global-agent home DMs.
    // Those channels require their named owner while they exist, so remove the
    // fixture's private homes first and let their cascading members/bindings
    // disappear before deleting the disposable account.
    await prisma.channel.deleteMany({
      where: {
        members: { some: { userId } },
        systemChannelType: { in: ['personal_assistant', 'system_agent'] },
        type: 'dm',
      },
    })
    await prisma.user.delete({ where: { id: userId } })
  } finally {
    await prisma.$disconnect()
  }
}

const permissionControls = (page) => ({
  addSprint: page.getByRole('button', { name: 'Add sprint', exact: true }),
  // Responsive headers retain a second action in the DOM for a transition.
  // The primary page action is the first matching control.
  configure: page.locator('[data-page-header-action="board-admin"]').first(),
})

/**
 * Drives a real non-owner browser session through the same project role rows
 * the server's `requireProjectAdmin` guard reads. The role changes happen in
 * the disposable fixture database only; focus causes the mounted entitlement
 * query to refresh without a browser reload.
 */
export const exerciseProjectAdministrationPermissions = async ({
  adminUrl,
  api,
  browser,
  project,
  runId,
  shot,
  token,
}) => {
  const password = `permissions-${runId}-password`
  const email = `project-permissions-${runId}@example.test`
  const user = await api('/api/users', {
    body: { displayName: `Project permissions ${runId}`, email, password, role: 'member' },
    method: 'POST',
    token,
  })
  let context
  try {
    const prisma = new PrismaClient()
    try {
      await prisma.projectMember.create({
        data: { projectId: project.id, role: 'viewer', userId: user.id },
      })
    } finally {
      await prisma.$disconnect()
    }
    const session = await api('/api/auth/session', {
      body: { email, password }, method: 'POST',
    })
    context = await openViewportContext(browser, { name: 'desktop', token: session.token })
    const memberPage = await context.newPage()
    const { page } = memberPage
    try {
      await page.goto(`${adminUrl}/projects/${project.id}/board`, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-kanban-board-viewport]').waitFor()
      const boardControls = permissionControls(page)
      await boardControls.configure.waitFor({ state: 'hidden' })

      await page.goto(`${adminUrl}/projects/${project.id}/backlog`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('heading', { name: 'Sprints', exact: true }).waitFor()
      const backlogControls = permissionControls(page)
      await backlogControls.addSprint.waitFor({ state: 'hidden' })

      // A project owner who is only an organisation member gets the same
      // board/sprint controls as an organisation owner, without reloading.
      await setProjectRole(project.id, user.id, 'owner')
      await refreshPermission(page)
      await waitFor(
        () => backlogControls.addSprint.isVisible(),
        'a promoted project owner did not receive the sprint control',
      )
      await page.goto(`${adminUrl}/projects/${project.id}/board`, { waitUntil: 'domcontentloaded' })
      await boardControls.configure.waitFor()
      await boardControls.configure.click()
      await page.getByRole('menuitem', { name: 'New board…', exact: true }).click()
      const boardDialog = page.getByRole('dialog', { name: 'New board' })
      await boardDialog.waitFor()
      await boardDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await boardDialog.waitFor({ state: 'hidden' })

      // An admin receives the same lifecycle controls. Creating through the UI
      // proves the client gate and the route agree for a non-owner.
      await setProjectRole(project.id, user.id, 'admin')
      await page.goto(`${adminUrl}/projects/${project.id}/backlog`, { waitUntil: 'domcontentloaded' })
      await refreshPermission(page)
      await waitFor(
        () => backlogControls.addSprint.isVisible(),
        'a promoted project admin did not receive the sprint control',
      )
      const sprintName = `Permission sprint ${runId}`
      await page.getByLabel('Sprint name').fill(sprintName)
      await backlogControls.addSprint.click()
      await waitFor(
        async () => (await api(`/api/projects/${project.id}/iterations`, { token: session.token }))
          .some((iteration) => iteration.name === sprintName),
        'a project admin could not create a sprint',
      )
      const start = page.getByRole('button', { name: 'Start', exact: true })
      await start.waitFor()
      await shot(page, 'desktop-project-administration-permissions')

      // Keep the old control mounted, revoke the role, and press it. The real
      // 403 must invalidate the shared entitlement query, hiding all shape
      // controls while the read-only backlog remains on screen.
      await setProjectRole(project.id, user.id, 'viewer')
      const refusal = page.waitForResponse((response) =>
        response.request().method() === 'PATCH'
        && /\/api\/iterations\//u.test(new URL(response.url()).pathname),
      )
      await start.click()
      assert.equal((await refusal).status(), 403, 'revoked project admin action reaches the server and is refused')
      await waitFor(
        async () => !(await backlogControls.addSprint.isVisible()),
        'a server 403 did not remove the stale sprint control',
      )
      await boardControls.configure.waitFor({ state: 'hidden' })
      await page.getByText(sprintName, { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).count(), 0)
    } finally {
      await memberPage.close()
    }
  } finally {
    await context?.close()
    await deleteFixtureUser(user.id)
  }
}
