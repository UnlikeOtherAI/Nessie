import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { openViewportContext } from '../navigation/lib/browser.mjs'

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
    // The browser user's private global-agent home DMs require their owner
    // while they exist, so they go first (see project-administration-permissions).
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

/**
 * Rule zero for the project directory: a plain organisation member who is not
 * in a project reaches "Browse all projects" from the Projects sidebar and sees
 * that project's name, description and members — and nothing to open or change.
 * The page is fed by `GET /api/projects/directory`, whose limited row carries no
 * other field; this case proves the doorway and the rendering.
 */
export const exerciseProjectDirectory = async ({
  adminUrl,
  api,
  browser,
  project,
  runId,
  shot,
  token,
}) => {
  const description = `Directory description ${runId}`
  await api(`/api/projects/${project.id}`, { body: { description }, method: 'PATCH', token })

  const password = `directory-${runId}-password`
  const email = `project-directory-${runId}@example.test`
  const user = await api('/api/users', {
    body: { displayName: `Project outsider ${runId}`, email, password, role: 'member' },
    method: 'POST',
    token,
  })
  let context
  try {
    const session = await api('/api/auth/session', { body: { email, password }, method: 'POST' })
    const entries = await api('/api/projects/directory', { token: session.token })
    const entry = entries.find((row) => row.id === project.id)
    assert.ok(entry, 'an outsider finds the project in the directory')
    assert.deepEqual(Object.keys(entry).sort(), ['access', 'description', 'id', 'members', 'name'])

    context = await openViewportContext(browser, { name: 'desktop', token: session.token })
    const outsiderPage = await context.newPage()
    const { page } = outsiderPage
    try {
      await page.goto(`${adminUrl}/projects`, { waitUntil: 'domcontentloaded' })
      const doorway = page.getByRole('link', { name: 'Browse all projects', exact: true })
      await doorway.waitFor()
      await doorway.click()
      await page.waitForURL(`${adminUrl}/projects/directory`)
      await page.getByRole('heading', { name: 'All projects' }).first().waitFor()

      const row = page.getByRole('listitem').filter({ hasText: project.name })
      await row.waitFor()
      await row.getByText(description, { exact: true }).waitFor()
      await row.getByText('You are not a member', { exact: true }).waitFor()
      assert.equal(
        await row.getByRole('link', { name: project.name }).count(),
        0,
        'an outsider is not offered a link into the project',
      )
      assert.equal(await row.getByRole('button').count(), 0, 'the directory row has no controls')
      await shot(page, 'desktop-project-directory-outsider')
    } finally {
      await outsiderPage.close()
    }
  } finally {
    await context?.close()
    await deleteFixtureUser(user.id)
  }
}
