#!/usr/bin/env node
// A real-project sidebar journey: two projects may share one existing team,
// and a channel created from the second project's menu stays in that project.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { API_URL, ADMIN_PORT } from '../navigation/lib/config.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'

const ADMIN_URL = `http://localhost:${ADMIN_PORT}`
const SCREENSHOTS = resolve(import.meta.dirname, '..', '..', '..', 'e2e', 'screenshots', 'project-usability')
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

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
  assert.ok(response.ok, `${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`)
  const payload = text ? JSON.parse(text) : null
  return payload?.data ?? payload
}

const createProjectThroughSidebar = async ({ name, page, teamId }) => {
  await page.getByRole('button', { name: 'Create project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a project' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByLabel('Team').selectOption(teamId)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('#sidebar-nav-projects').getByRole('button', { name, exact: true }).waitFor()
}

// `DELETE /api/channels/:id` deliberately archives recoverable conversation
// history. This disposable test must then remove its one channel before it can
// prove project deletion's empty-project guard, so teardown uses the scoped id
// it just created. Every creation and assertion above remains on the live API.
const removeFixtureChannel = async (channelId) => {
  const prisma = new PrismaClient()
  try {
    await prisma.channel.delete({ where: { id: channelId } })
  } finally {
    await prisma.$disconnect()
  }
}

const main = async () => {
  const seed = await seedTeam({ output: () => '' })
  const teams = await call('/api/teams', { token: seed.token })
  const team = teams.find((candidate) => candidate.projectIds.includes(seed.project.id))
  assert.ok(team, 'the local fixture provides the existing team that owns its initial project')

  const firstProjectName = `Shared team first ${runId}`
  const secondProjectName = `Shared team second ${runId}`
  const channelName = `second-project-channel-${runId}`
  let browser
  let context
  let page
  let createdChannel
  let createdProjects = []
  try {
    browser = await launchBrowser()
    context = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    page = await context.newPage()
    await page.page.goto(`${ADMIN_URL}/channels/projects/${seed.project.id}`, { waitUntil: 'domcontentloaded' })
    await page.page.locator('#sidebar-nav-projects').waitFor({ timeout: 60_000 })

    await createProjectThroughSidebar({ name: firstProjectName, page: page.page, teamId: team.id })
    await createProjectThroughSidebar({ name: secondProjectName, page: page.page, teamId: team.id })

    const projects = await api('/api/projects', { token: seed.token })
    const firstProject = projects.find((project) => project.name === firstProjectName)
    const secondProject = projects.find((project) => project.name === secondProjectName)
    assert.ok(firstProject && secondProject, 'both sidebar-created projects are returned by the live projects API')
    createdProjects = [firstProject, secondProject]

    const refreshedTeam = (await call('/api/teams', { token: seed.token }))
      .find((candidate) => candidate.id === team.id)
    assert.ok(refreshedTeam, 'the fixture team remains visible after creating projects')
    assert.ok(
      refreshedTeam.projectIds.includes(firstProject.id) && refreshedTeam.projectIds.includes(secondProject.id),
      'both new projects belong to the one pre-existing team',
    )

    await page.page.getByLabel(`Project actions for ${secondProjectName}`).click()
    await page.page.getByRole('button', { name: 'Add new channel within project' }).click()
    const channelDialog = page.page.getByRole('dialog', { name: 'Create a channel' })
    await channelDialog.getByRole('textbox', { name: 'Name' }).fill(channelName)
    const channelResponse = page.page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/channels',
    )
    await channelDialog.getByRole('button', { name: 'Create channel' }).click()
    const creationResponse = await channelResponse
    const channelCreation = {
      request: creationResponse.request().postData() ?? null,
      response: await creationResponse.text(),
      status: creationResponse.status(),
    }
    if (channelCreation.status >= 400) {
      assert.fail(
        `channel creation failed: ${JSON.stringify(channelCreation)}`,
      )
    }
    const formError = channelDialog.getByRole('alert')
    if (await formError.count()) {
      assert.fail(
        `channel creation failed: ${await formError.innerText()} request=${channelCreationRequest} response=${JSON.stringify(channelCreationResponse)}`,
      )
    }
    await channelDialog.waitFor({ state: 'hidden' })
    await page.page.waitForURL(new RegExp('/channels/[0-9a-f-]{36}$', 'u'))

    createdChannel = (await api('/api/channels', { token: seed.token }))
      .find((channel) => channel.label === channelName)
    assert.ok(createdChannel, 'the live channels API returns the channel created from the sidebar')
    assert.equal(createdChannel.projectId, secondProject.id, 'the new channel belongs to the selected second project')
    assert.equal(createdChannel.teamId, team.id, 'the new channel belongs to the selected existing team')
    assert.match(page.page.url(), new RegExp(`/channels/${createdChannel.id}$`, 'u'), 'creation navigates to the new channel')

    await page.page.reload({ waitUntil: 'domcontentloaded' })
    const secondProjectRow = page.page.locator('#sidebar-nav-projects').getByRole('button', {
      name: secondProjectName,
      exact: true,
    })
    await secondProjectRow.waitFor({ timeout: 60_000 })
    await page.page.locator(`#sidebar-project-${secondProject.id}-channels`)
      .getByText(channelName, { exact: true })
      .waitFor()
    assert.equal(await page.page.getByText('Loading…', { exact: true }).count(), 0, 'the reloaded channel screen is fully loaded')

    await mkdir(SCREENSHOTS, { recursive: true })
    await page.page.screenshot({
      fullPage: false,
      path: resolve(SCREENSHOTS, 'project-team-channel.png'),
    })
    console.log(`project-team-channel e2e: passed (${secondProjectName} → ${channelName})`)
  } finally {
    if (page) await page.close()
    if (context) await context.close()
    if (browser) await browser.close()
    if (createdChannel) await removeFixtureChannel(createdChannel.id)
    for (const project of createdProjects.reverse()) {
      await api(`/api/projects/${project.id}`, { method: 'DELETE', token: seed.token })
    }
  }
}

await main()
