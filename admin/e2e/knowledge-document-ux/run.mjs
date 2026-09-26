#!/usr/bin/env node
// Headless visual regression for Knowledge Tree and document creation.
import assert from 'node:assert/strict'
import { ADMIN_URL, API_URL } from '../navigation/lib/config.mjs'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'
import { seedKnowledgeAgent } from '../navigation/lib/agent-seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

let api
let admin
let browser
try {
  api = await startApi({ reuseExisting: false })
  let seed
  try {
    seed = await seedTeam(api)
  } catch (error) {
    console.error(api.output().slice(-4000).replaceAll(/token=[^\s"']+/gu, 'token=[redacted]'))
    throw error
  }
  const initialRoot = await call('/api/knowledge-base/root', { token: seed.token })
  if (initialRoot.agentHomes.length === 0) await seedKnowledgeAgent(seed)
  admin = await startAdmin({ reuseExisting: false })
  const root = await call('/api/knowledge-base/root', { token: seed.token })
  const projectRoot = root.projects.find(({ projectId }) => projectId === seed.project.id)
  assert.ok(projectRoot, 'project root is visible')
  assert.ok(root.agentHomes.length > 0, 'fixture includes an agent document home')
  browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript((token) => localStorage.setItem('nessie.admin.token', token), seed.token)
  const treePane = page.locator('[data-knowledge-tree-pane]').last()
  const tree = treePane.locator('.knowledge-sidebar-tree-panel')
  const row = (id) => tree.locator(`[data-finder-tree-row="true"][data-finder-row="${id}"]`)
  const suffix = Date.now().toString(36)
  const publishedTitle = `Published from create ${suffix}`
  const draftTitle = `Saved as draft ${suffix}`
  const go = (path) => page.goto(
    `${ADMIN_URL}${path}${path.includes('?') ? '&' : '?'}view=tree`,
    { timeout: 120_000, waitUntil: 'domcontentloaded' },
  )

  await go('/knowledge-base')
  await row('virtual:agents').click()
  await page.waitForURL(/\/knowledge-base\/agents\?view=tree/)
  assert.equal(new URL(page.url()).searchParams.get('view'), 'tree')
  assert.equal(await page.locator('[data-column-browser-track]').count(), 0)
  assert.equal(await tree.count(), 1, 'Agents stays in one Tree hierarchy')
  const home = root.agentHomes[0]
  await row(home.spaceId).click()
  await page.waitForURL(new RegExp(`/knowledge-base/agents/${home.ownerAgentId}`))
  await row(home.spaceId).and(page.locator('[aria-selected="true"]')).waitFor()
  assert.equal(await page.locator('[data-column-browser-track]').count(), 0)
  assert.equal(await tree.count(), 1, 'agent home does not create a second tree column')
  await page.screenshot({ path: '/private/tmp/nessie-knowledge-agents-tree.png', fullPage: true })
  const agentPages = await call(`/api/knowledge-base/spaces/${home.spaceId}/pages`, { token: seed.token })
  for (const entry of agentPages.filter(({ parentPageId }) => !parentPageId)) {
    await row(entry.id).first().waitFor()
    const matches = await row(entry.id).evaluateAll((elements) => elements.map((element) => ({
      inSpaces: Boolean(element.closest('#finder-spaces')),
      parent: element.parentElement?.parentElement?.textContent?.slice(0, 100),
    })))
    assert.equal(matches.length, 1, `${entry.title} appears once in Tree: ${JSON.stringify(matches)}`)
  }

  const projectPath = `/knowledge-base/spaces/${projectRoot.space.spaceId}`
  await go(projectPath)
  await row(projectRoot.space.spaceId).waitFor()
  await page.locator('[data-page-header-action="sharing-settings"]:visible').last().click()
  const settings = page.getByRole('dialog').last()
  await settings.getByText(`${seed.project.name} settings`).waitFor()
  assert.equal(await settings.getByRole('textbox', { name: 'Project folder' }).inputValue(), seed.project.name)
  await page.screenshot({ path: '/private/tmp/nessie-knowledge-project-settings.png', fullPage: true })
  await settings.getByRole('button', { name: 'Close' }).click()

  await page.locator('[data-page-header-action="new"]:visible').last().click()
  await page.getByRole('menuitem', { name: 'Document' }).click()
  await page.getByRole('textbox', { name: 'Document title' }).fill(publishedTitle)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByRole('heading', { name: publishedTitle, exact: true }).last().waitFor()
  const publishedPages = await call(`/api/knowledge-base/spaces/${projectRoot.space.spaceId}/pages`, {
    token: seed.token,
  })
  const published = publishedPages.find(({ title }) => title === publishedTitle)
  assert.equal(published?.status, 'published', 'primary creation action publishes immediately')
  await page.getByRole('button', { name: 'Attachments', exact: true }).last().click()
  await page.waitForFunction(() => document.activeElement?.id === 'knowledge-page-attachments')
  await page.screenshot({ path: '/private/tmp/nessie-knowledge-attachments.png', fullPage: true })

  await go(projectPath)
  await page.locator('[data-page-header-action="new"]:visible').last().click()
  await page.getByRole('menuitem', { name: 'Document' }).click()
  await page.getByRole('textbox', { name: 'Document title' }).fill(draftTitle)
  await page.getByRole('button', { name: 'Save as draft' }).click()
  await page.getByRole('heading', { name: draftTitle, exact: true }).last().waitFor()
  const draftPages = await call(`/api/knowledge-base/spaces/${projectRoot.space.spaceId}/pages`, {
    token: seed.token,
  })
  const draft = draftPages.find(({ title }) => title === draftTitle)
  assert.equal(draft?.status, 'draft')
  await row(draft.id).getByText('Draft', { exact: true }).waitFor()
  await page.screenshot({ path: '/private/tmp/nessie-knowledge-draft-tree.png', fullPage: true })
  console.log(`Knowledge document UX passed at ${API_URL} and ${ADMIN_URL}`)
} finally {
  await browser?.close()
  await stopProcess(admin)
  await stopProcess(api)
}
