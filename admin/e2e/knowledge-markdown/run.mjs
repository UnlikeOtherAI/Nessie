#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..', '..', '..')
const apiUrl = 'http://localhost:5454'
const adminUrl = 'http://localhost:5455'
const screenshot = resolve(root, 'e2e', 'screenshots', 'knowledge-markdown', 'canonical-flow.png')
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const waitFor = async (url) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).status < 500) return } catch { /* poll */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`${url} did not become ready`)
}
const start = (filter) => spawn('pnpm.cmd', ['--filter', filter, 'dev'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl, NESSIE_DB_URL: databaseUrl },
  shell: process.platform === 'win32',
  stdio: 'ignore',
  windowsHide: true,
})
const stop = (child) => child?.pid && process.platform === 'win32'
  ? new Promise((done) => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).once('exit', done))
  : undefined
const main = async () => {
  const api = start('@nessie/api'); const admin = start('@nessie/admin')
  let browser
  try {
    await Promise.all([waitFor(`${apiUrl}/api/health`), waitFor(adminUrl)])
    const login = await (await fetch(`${apiUrl}/api/auth/dev-login`)).json()
    const token = login.data.token
    const call = async (path, init = {}) => {
      const response = await fetch(`${apiUrl}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
      const payload = await response.json()
      if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`)
      return payload.data
    }
    const project = (await call('/api/projects'))[0]
    const space = await call('/api/knowledge-base/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Markdown QA ${Date.now()}`, projectId: project.id }) })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.addInitScript((value) => localStorage.setItem('nessie.admin.token', value), token)
    await page.goto(`${adminUrl}/knowledge-base?spaceId=${space.id}`, { waitUntil: 'domcontentloaded' })
    await page.locator('input[type=file]').setInputFiles({ name: 'entry.md', mimeType: 'text/markdown', buffer: Buffer.from('# Canonical\n\nfirst') })
    await page.getByText('entry.md').first().waitFor()
    let node
    for (let attempt = 0; attempt < 40 && !node; attempt += 1) {
      node = (await call(`/api/knowledge-base/spaces/${space.id}/pages`)).find((entry) => entry.title === 'entry.md')
      if (!node) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(node, 'upload creates a file node')
    const baseVersion = node.latestVersion.id
    await page.goto(`${adminUrl}/knowledge-base?spaceId=${space.id}&pageId=${node.id}`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('markdown-file-preview').waitFor()
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Canonical\n\nchanged')
    await page.getByRole('button', { name: 'Save new version' }).click()
    await page.getByText('changed').waitFor()
    let saved = await call(`/api/knowledge-base/pages/${node.id}`)
    const bytes = await (await fetch(`${apiUrl}/api/knowledge-base/pages/${node.id}/versions/${saved.latestVersion.id}/download`, { headers: { authorization: `Bearer ${token}` } })).text()
    assert.equal(bytes, saved.latestVersion.body)
    assert.equal(bytes, '# Canonical\n\nchanged')
    await call(`/api/knowledge-base/pages/${node.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'renamed-without-extension', expectedRevision: saved.revision }) })
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByTestId('markdown-file-preview').waitFor()
    const conflict = await fetch(`${apiUrl}/api/knowledge-base/pages/${node.id}/file-version`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-knowledge-base-version': baseVersion, 'content-type': 'text/markdown' }, body: '# stale' })
    assert.equal(conflict.status, 409, 'pinned base version rejects a stale save')
    await mkdir(resolve(root, 'e2e', 'screenshots', 'knowledge-markdown'), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })
    console.log('knowledge-markdown e2e: passed')
  } finally { await browser?.close(); await stop(admin); await stop(api) }
}
await main()
