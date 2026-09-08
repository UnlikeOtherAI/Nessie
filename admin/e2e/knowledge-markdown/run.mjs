#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const waitFor = async (url, ready) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (await ready(response)) return
    } catch { /* poll */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`${url} did not become ready`)
}
const start = (filter) => {
  const windows = process.platform === 'win32'
  return spawn(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
    windows ? ['/d', '/s', '/c', `pnpm.cmd --filter ${filter} dev`] : ['--filter', filter, 'dev'],
    {
      cwd: root,
      detached: !windows,
      env: { ...process.env, DATABASE_URL: databaseUrl, NESSIE_DB_URL: databaseUrl },
      stdio: 'ignore',
      windowsHide: true,
    },
  )
}
const stop = async (child) => {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((done) => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).once('exit', done))
    return
  }
  await new Promise((done) => {
    const timeout = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, 10_000)
    child.once('exit', () => { clearTimeout(timeout); done() })
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  })
}
const main = async () => {
  const api = start('@nessie/api'); const admin = start('@nessie/admin')
  let browser
  try {
    await Promise.all([
      waitFor(`${apiUrl}/api/health`, async (response) => response.status === 200),
      waitFor(adminUrl, async (response) => response.status === 200 && (await response.text()).includes('@vite/client')),
    ])
    console.log('knowledge-markdown e2e: services ready')
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
    const openPage = async () => {
      const page = await browser.newPage()
      await page.addInitScript((value) => localStorage.setItem('nessie.admin.token', value), token)
      return page
    }
    const page = await openPage()
    await page.goto(`${adminUrl}/knowledge-base/spaces/${space.id}`, { waitUntil: 'domcontentloaded' })
    await page.getByText(space.name).first().waitFor()
    await page.locator('input[type=file]').setInputFiles({ name: 'entry.md', mimeType: 'text/markdown', buffer: Buffer.from('# Canonical\n\nfirst') })
    await page.getByText('entry.md').first().waitFor()
    let node
    for (let attempt = 0; attempt < 40 && !node; attempt += 1) {
      node = (await call(`/api/knowledge-base/spaces/${space.id}/pages`)).find((entry) => entry.title === 'entry.md')
      if (!node) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(node, 'upload creates a file node')
    console.log('knowledge-markdown e2e: upload created node')
    const baseVersion = node.latestVersion.id
    const fileRoute = `${adminUrl}/knowledge-base/spaces/${space.id}?pageId=${node.id}`
    const openMarkdownEditor = async (editorPage) => {
      await editorPage.goto(fileRoute, { waitUntil: 'domcontentloaded' })
      await editorPage.getByText(space.name).first().waitFor()
      await editorPage.getByTestId('markdown-file-preview').waitFor()
      await editorPage.getByRole('button', { name: 'Edit' }).click()
      await editorPage.getByRole('textbox', { name: 'Markdown source' }).waitFor()
    }
    await openMarkdownEditor(page)
    await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Canonical\n\nchanged')
    await page.getByRole('button', { name: 'Save new version' }).click()
    await page.getByText('changed').waitFor()
    let saved
    for (let attempt = 0; attempt < 40; attempt += 1) {
      saved = await call(`/api/knowledge-base/pages/${node.id}`)
      if (saved.latestVersion.id !== baseVersion) break
      await new Promise((done) => setTimeout(done, 250))
    }
    assert.notEqual(saved.latestVersion.id, baseVersion, 'editor save creates a new version')
    const bytes = await (await fetch(`${apiUrl}/api/knowledge-base/pages/${node.id}/versions/${saved.latestVersion.id}/download`, { headers: { authorization: `Bearer ${token}` } })).text()
    assert.equal(bytes, '# Canonical\n\nchanged')
    assert.equal(saved.latestVersion.body, '<h1>Canonical</h1>\n<p>changed</p>\n')
    assert.equal(saved.latestVersion.sourceContentHash, createHash('sha256').update(bytes).digest('hex'))
    console.log('knowledge-markdown e2e: canonical bytes, body, and hash match')
    await call(`/api/knowledge-base/pages/${node.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'renamed-without-extension', expectedRevision: saved.revision }) })
    await page.goto(fileRoute, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('markdown-file-preview').waitFor()
    assert.equal(await page.getByTestId('markdown-file-preview').textContent(), 'Canonical\nchanged')
    console.log('knowledge-markdown e2e: renamed file reopens as Markdown')

    // These dialogs both pin the same version before either write happens. The
    // second is deliberately stale, so this proves the XHR multipart
    // `baseVersionId` contract as a person experiences it.
    const staleEditor = await openPage()
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('textbox', { name: 'Markdown source' }).waitFor()
    await openMarkdownEditor(staleEditor)
    await page.getByRole('textbox', { name: 'Markdown source' }).fill('# Canonical\n\nnewer version')
    await page.getByRole('button', { name: 'Save new version' }).click()
    await page.getByText('newer version').waitFor()
    await staleEditor.getByRole('textbox', { name: 'Markdown source' }).fill('# Canonical\n\nstale draft')
    await staleEditor.getByRole('button', { name: 'Save new version' }).click()
    await staleEditor.getByRole('dialog').getByText('The file changed after this Markdown editor opened').waitFor()
    console.log('knowledge-markdown e2e: stale UI save was rejected')
    assert.equal(
      await staleEditor.getByRole('textbox', { name: 'Markdown source' }).inputValue(),
      '# Canonical\n\nstale draft',
      'a rejected UI save keeps the draft open for resolution',
    )
    const afterConflict = await call(`/api/knowledge-base/pages/${node.id}`)
    assert.equal(afterConflict.latestVersion.body, '<h1>Canonical</h1>\n<p>newer version</p>\n')
    assert.equal(
      afterConflict.latestVersion.sourceContentHash,
      createHash('sha256').update('# Canonical\n\nnewer version').digest('hex'),
      'the stale editor does not overwrite the newer version',
    )
    await mkdir(resolve(root, 'e2e', 'screenshots', 'knowledge-markdown'), { recursive: true })
    await staleEditor.screenshot({ path: screenshot, fullPage: true })
    console.log('knowledge-markdown e2e: passed')
  } finally {
    await browser?.close()
    await stop(admin)
    await stop(api)
    console.log('knowledge-markdown e2e: owned servers stopped')
  }
}
await main()
