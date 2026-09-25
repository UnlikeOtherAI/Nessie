#!/usr/bin/env node
// A plain-text title match must never be presented as a document relationship.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { resolveDevPorts } from '../../../scripts/dev-ports.mjs'

const { api, admin } = resolveDevPorts()
const apiUrl = `http://127.0.0.1:${api}`
const adminUrl = `http://127.0.0.1:${admin}`
const login = await fetch(`${apiUrl}/api/auth/dev-login`)
assert.equal(login.status, 200, 'local dev login succeeds')
const token = (await login.json()).data.token
const call = async (path, init = {}) => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  const payload = await response.json()
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload.data
}
const create = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
const [project] = await call('/api/projects')
assert.ok(project, 'fixture has a project')
const space = await create('/api/knowledge-base/spaces', {
  name: `Backlinks QA ${Date.now()}`,
  projectId: project.id,
})
const pagePath = `/api/knowledge-base/spaces/${space.id}/pages`
const about = await create(pagePath, { title: 'About', body: '<p>About this project.</p>' })
await create(pagePath, {
  title: '7_Powers (2) (1).pdf',
  body: '<p>About the project, but with no link to the About document.</p>',
})
await create(pagePath, {
  title: 'Related note',
  body: `<p><a data-kb-page-id="${about.id}">About</a></p>`,
})

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript((value) => localStorage.setItem('nessie.admin.token', value), token)
  await page.goto(`${adminUrl}/knowledge-base/spaces/${space.id}?view=tree&pageId=${about.id}`)
  await page.getByRole('heading', { name: 'About', exact: true }).last().waitFor()
  await page.getByRole('button', { name: /Linked from \(1\)/i }).click()
  await page.getByRole('button', { name: 'Related note' }).waitFor()
  assert.equal(await page.getByText(/Unlinked mentions/i).count(), 0)
  assert.equal(await page.getByText(/7_Powers \(2\) \(1\)\.pdf/).count(), 1,
    'unrelated PDF appears only as its own tree item, not as a mention')
  await page.screenshot({ path: '/private/tmp/nessie-knowledge-backlinks.png', fullPage: true })
  console.log('Knowledge backlinks visual check passed: explicit link shown, title-only PDF match absent')
} finally {
  await browser.close()
}
