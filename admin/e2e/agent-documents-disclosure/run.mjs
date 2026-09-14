#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { ensureAgentDocsSpace } from '@nessie/knowledge'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..', '..', '..')
const apiUrl = 'http://localhost:5454'
const adminUrl = 'http://localhost:5455'
const screenshot = resolve(root, 'e2e', 'screenshots', 'agent-documents-disclosure', 'restricted-title.png')
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const assertPortsFree = async () => {
  for (const url of [apiUrl, adminUrl]) {
    try {
      await fetch(url)
      throw new Error(`${url} is already occupied; this evaluation will not adopt another task's server`)
    } catch (error) {
      if (error instanceof Error && error.message.includes('already occupied')) throw error
    }
  }
}

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
  const child = spawn(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm',
    windows ? ['/d', '/s', '/c', `pnpm.cmd --filter ${filter} dev`] : ['--filter', filter, 'dev'],
    {
      cwd: root,
      detached: !windows,
      env: { ...process.env, DATABASE_URL: databaseUrl, NESSIE_DB_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let output = ''
  const append = (chunk) => { output = `${output}${chunk}`.slice(-8_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.output = () => output
  return child
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
  await assertPortsFree()
  const api = start('@nessie/api')
  const admin = start('@nessie/admin')
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  let browser
  try {
    try {
      await Promise.all([
        waitFor(`${apiUrl}/api/health`, async (response) => response.status === 200),
        waitFor(adminUrl, async (response) => response.status === 200 && (await response.text()).includes('@vite/client')),
      ])
    } catch (error) {
      throw new Error(`${error.message}\n--- API ---\n${api.output()}\n--- admin ---\n${admin.output()}`)
    }
    const loginResponse = await fetch(`${apiUrl}/api/auth/dev-login`)
    assert.equal(loginResponse.status, 200, 'the disposable local database has a dev-login user')
    const login = await loginResponse.json()
    const token = login.data.token
    const me = login.data.me
    const call = async (path, init = {}) => {
      const response = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`)
      return payload.data
    }
    const project = (await call('/api/projects'))[0]
    assert.ok(project, 'the authenticated local owner has a project for the agent home')
    const agent = await call('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Disclosure browser ${Date.now()}`, role: 'assistant' }),
    })
    const home = await ensureAgentDocsSpace(prisma, {
      organizationId: me.organizationId,
      projectId: project.id,
      agentId: agent.id,
      agentName: agent.name,
    })
    const controlTitle = `Visible title ${randomUUID()}`
    const control = await call(`/api/knowledge-base/spaces/${home.spaceId}/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'document', title: controlTitle, body: '<p>visible</p>' }),
    })
    assert.ok(control.id, 'the control document was created')
    const secretTitle = `Restricted title ${randomUUID()}`
    const restricted = await call(`/api/knowledge-base/spaces/${home.spaceId}/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'document', title: secretTitle, body: '<p>restricted</p>' }),
    })
    await prisma.knowledgePageVersionBasisScope.create({
      data: {
        organizationId: me.organizationId,
        scopeId: randomUUID(),
        scopeType: 'user',
        versionId: restricted.latestVersion.id,
      },
    })

    const listed = await call(`/api/knowledge-base/spaces/${home.spaceId}/pages`)
    assert.equal(listed.some((page) => page.id === control.id && page.title === controlTitle), true, 'page list retains an unrestricted control title')
    assert.equal(listed.some((page) => page.id === restricted.id || page.title === secretTitle), false, 'restricted version title is absent from the page list')
    for (const path of [
      `/api/knowledge-base/pages/${restricted.id}`,
      `/api/knowledge-base/pages/${restricted.id}/comments`,
    ]) {
      const response = await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
      const text = await response.text()
      assert.equal(response.ok, false, `${path} refuses an unreadable historical version`) 
      assert.equal(text.includes(secretTitle), false, `${path} does not disclose the restricted title`) 
    }

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.addInitScript((value) => localStorage.setItem('nessie.admin.token', value), token)
    await page.goto(`${adminUrl}/agents/${agent.id}?agentTab=documents`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Documents can have narrower access than this agent. Don’t store secrets here.').waitFor()
    await page.getByText(controlTitle, { exact: true }).waitFor()
    assert.equal(await page.getByText(secretTitle, { exact: true }).count(), 0, 'the Agent Documents workspace never renders the restricted title')
    await mkdir(resolve(root, 'e2e', 'screenshots', 'agent-documents-disclosure'), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: true })
    console.log(`agent-documents-disclosure e2e: passed (${screenshot})`)
  } finally {
    await browser?.close()
    await prisma.$disconnect()
    await stop(admin)
    await stop(api)
    console.log('agent-documents-disclosure e2e: owned servers stopped')
  }
}

await main()
