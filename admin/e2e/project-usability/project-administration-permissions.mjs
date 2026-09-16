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

const withPrisma = async (run) => {
  const prisma = new PrismaClient()
  try {
    return await run(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

const deleteFixtureUser = async (userId) => {
  await withPrisma(async (prisma) => {
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
    await prisma.projectMember.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } })
  })
}

const permissionControls = (page) => ({
  addSprint: page.getByRole('button', { name: 'Add sprint', exact: true }),
  // Responsive headers retain a second action in the DOM for a transition.
  // The primary page action is the first matching control.
  configure: page.locator('[data-page-header-action="board-admin"]').first(),
})

/**
 * Drives a real non-owner browser session through the equal-rights rule the
 * server's `requireProjectModifier` guard enforces: any member of a project —
 * whatever `ProjectMember.role` says — gets the project's controls, and losing
 * the membership takes them away. The membership changes happen in the
 * disposable fixture database only.
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
    // The lowest project role there is. It used to hide every shape control;
    // under the model it is simply a member, with the creator's rights.
    await withPrisma((prisma) => prisma.projectMember.create({
      data: { projectId: project.id, role: 'viewer', userId: user.id },
    }))
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
      await boardControls.configure.waitFor()
      await boardControls.configure.click()
      await page.getByRole('menuitem', { name: 'New board…', exact: true }).click()
      const boardDialog = page.getByRole('dialog', { name: 'New board' })
      await boardDialog.waitFor()
      await boardDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await boardDialog.waitFor({ state: 'hidden' })

      // Creating through the UI proves the client gate and the route agree for
      // a plain project member who is only an organisation member.
      await page.goto(`${adminUrl}/projects/${project.id}/backlog`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('heading', { name: 'Sprints', exact: true }).waitFor()
      const backlogControls = permissionControls(page)
      await backlogControls.addSprint.waitFor()
      const sprintName = `Permission sprint ${runId}`
      await page.getByLabel('Sprint name').fill(sprintName)
      await backlogControls.addSprint.click()
      await waitFor(
        async () => (await api(`/api/projects/${project.id}/iterations`, { token: session.token }))
          .some((iteration) => iteration.name === sprintName),
        'a plain project member could not create a sprint',
      )
      const start = page.getByRole('button', { name: 'Start', exact: true })
      await start.waitFor()
      await shot(page, 'desktop-project-administration-permissions')

      // Keep the old control mounted, remove the membership, and press it. The
      // person can no longer see the project, so the server answers 404; that
      // refusal must invalidate the shared entitlement query and hide the
      // controls rather than leave a button every click of which fails.
      await withPrisma((prisma) => prisma.projectMember.delete({
        where: { projectId_userId: { projectId: project.id, userId: user.id } },
      }))
      const refusal = page.waitForResponse((response) =>
        response.request().method() === 'PATCH'
        && /\/api\/iterations\//u.test(new URL(response.url()).pathname),
      )
      await start.click()
      assert.equal((await refusal).status(), 404, 'a removed member reaches the server and is refused')
      await refreshPermission(page)
      await waitFor(
        async () => !(await backlogControls.addSprint.isVisible()),
        'a server refusal did not remove the stale sprint control',
      )
    } finally {
      await memberPage.close()
    }
  } finally {
    await context?.close()
    await deleteFixtureUser(user.id)
  }
}
