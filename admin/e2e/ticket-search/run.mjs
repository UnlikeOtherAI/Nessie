#!/usr/bin/env node
// Search's ticket doorway must open the one shared board dialog, not a copy.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { ADMIN_PORT, API_URL } from '../navigation/lib/config.mjs'
import { seedTeam } from '../navigation/lib/seed.mjs'

const ADMIN_URL = `http://localhost:${ADMIN_PORT}`
const SCREENSHOTS = resolve(import.meta.dirname, '..', '..', '..', 'e2e', 'screenshots', 'project-usability')
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const api = async (path, { body, method = 'GET', token } = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    method,
  })
  const text = await response.text()
  assert.ok(response.ok, `${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`)
  const payload = text ? JSON.parse(text) : null
  return payload?.data ?? payload
}

const main = async () => {
  const seed = await seedTeam({ output: () => '' })
  const title = `Search ticket ${runId}`
  const prisma = new PrismaClient()
  let browser; let connectionId; let context; let page; let project
  try {
    const me = await api('/api/auth/me', { token: seed.token })
    project = await api('/api/projects', {
      body: { name: `Search fixture ${runId}`, teamId: seed.team.id }, method: 'POST', token: seed.token,
    })
    const task = await api('/api/tasks', {
      body: { projectId: project.id, title }, method: 'POST', token: seed.token,
    })
    const externalTask = await api('/api/tasks', {
      body: { projectId: project.id, title: `Unrelated mirror ${runId}` }, method: 'POST', token: seed.token,
    })
    const connection = await prisma.boardSourceConnection.create({
      data: {
        externalAccountId: `search-account-${runId}`,
        externalTenantId: `search-tenant-${runId}`,
        organizationId: project.organizationId,
        ownerUserId: me.user.id,
        provider: 'linear',
      },
    })
    connectionId = connection.id
    const source = await prisma.boardSource.create({
      data: {
        connectionId: connection.id,
        container: { id: `search-container-${runId}` },
        containerKey: `search-container-${runId}`,
        createdByUserId: me.user.id,
        name: `Search source ${runId}`,
        organizationId: project.organizationId,
        projectId: project.id,
        provider: 'linear',
      },
    })
    const externalKey = `ENG-${runId.toUpperCase()}`
    await prisma.taskExternalLink.create({
      data: {
        externalId: `external-${runId}`,
        externalKey,
        externalUrl: `https://linear.example.test/${runId}`,
        organizationId: project.organizationId,
        sourceId: source.id,
        taskId: externalTask.id,
      },
    })
    const searched = await api(`/api/tasks/search?query=${encodeURIComponent(title)}`, { token: seed.token })
    assert.deepEqual(searched.map((row) => row.id), [task.id], 'the HTTP route finds a native title')
    const nonmatching = await api(`/api/tasks/search?query=${encodeURIComponent(`missing-${runId}`)}`, { token: seed.token })
    assert.deepEqual(nonmatching, [], 'the HTTP route does not return a nonmatching task')
    const byExternalKey = await api(`/api/tasks/search?query=${encodeURIComponent(externalKey)}`, { token: seed.token })
    assert.deepEqual(byExternalKey.map((row) => row.id), [externalTask.id], 'the HTTP route finds a mirrored external key')
    browser = await launchBrowser()
    context = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    page = await context.newPage()
    const expired = new URLSearchParams({
      mode: 'text', query: title, 'tasks-cursor': 'expired-cursor', 'tasks-direction': 'forward',
      'tasks-page': '1', 'tasks-scope': `task-search:${title}`,
    })
    await page.page.goto(`${ADMIN_URL}/search?${expired}`, { waitUntil: 'domcontentloaded' })
    const restart = page.page.getByRole('button', { name: 'Restart task search' })
    await restart.waitFor()
    if (process.env.PROJECT_USABILITY_SCREENSHOTS === '1') {
      await mkdir(SCREENSHOTS, { recursive: true })
      await page.page.screenshot({ path: `${SCREENSHOTS}/ticket-search-expired-cursor.png`, fullPage: false })
    }
    await restart.click()
    await page.page.waitForURL((url) => (
      url.searchParams.get('query') === title
      && url.searchParams.get('mode') === 'text'
      && ![...url.searchParams.keys()].some((key) => key.startsWith('tasks-'))
    ))
    const taskSection = page.page.getByRole('heading', { name: 'Tasks', exact: true }).locator('..')
    const result = taskSection.getByRole('button', { name: new RegExp(title, 'u') })
    try {
      await result.waitFor({ timeout: 60_000 })
    } catch (error) {
      await mkdir(SCREENSHOTS, { recursive: true })
      await page.page.screenshot({ path: `${SCREENSHOTS}/ticket-search-failed.png`, fullPage: false })
      throw error
    }
    if (process.env.PROJECT_USABILITY_SCREENSHOTS === '1') {
      await mkdir(SCREENSHOTS, { recursive: true })
      await page.page.screenshot({ path: `${SCREENSHOTS}/ticket-search-results.png`, fullPage: false })
    }
    await result.click()
    await page.page.waitForURL(new RegExp(`/projects/${project.id}/board\\?task=${task.id}$`, 'u'))
    const dialog = page.page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('textbox', { name: 'Title' }).waitFor()
    assert.equal(await dialog.getByRole('textbox', { name: 'Title' }).inputValue(), title)
    if (process.env.PROJECT_USABILITY_SCREENSHOTS === '1') {
      await page.page.screenshot({ path: `${SCREENSHOTS}/ticket-search-task-detail.png`, fullPage: false })
    }
  } finally {
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (project) await api(`/api/projects/${project.id}`, { method: 'DELETE', token: seed.token }).catch(() => {})
    if (connectionId) await prisma.boardSourceConnection.delete({ where: { id: connectionId } }).catch(() => {})
    await prisma.$disconnect()
  }
}

await main()
console.log('ticket search e2e passed')
