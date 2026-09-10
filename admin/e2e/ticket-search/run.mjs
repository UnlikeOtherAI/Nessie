#!/usr/bin/env node
// Search's ticket doorway must open the one shared board dialog, not a copy.

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

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
  let browser; let context; let page; let project
  try {
    project = await api('/api/projects', {
      body: { name: `Search fixture ${runId}`, teamId: seed.team.id }, method: 'POST', token: seed.token,
    })
    const task = await api('/api/tasks', {
      body: { projectId: project.id, title }, method: 'POST', token: seed.token,
    })
    const searched = await api(`/api/tasks/search?query=${encodeURIComponent(title)}`, { token: seed.token })
    assert.deepEqual(searched.map((row) => row.id), [task.id], 'the human search route finds the created task')
    browser = await launchBrowser()
    context = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    page = await context.newPage()
    await page.page.goto(`${ADMIN_URL}/search?mode=text&query=${encodeURIComponent(title)}`, { waitUntil: 'domcontentloaded' })
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
  }
}

await main()
console.log('ticket search e2e passed')
