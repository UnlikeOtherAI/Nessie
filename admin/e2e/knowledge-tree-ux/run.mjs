#!/usr/bin/env node
// Read-only browser audit of every Knowledge Tree root and folder in the local fixture.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { resolveDevPorts } from '../../../scripts/dev-ports.mjs'

const { api, admin } = resolveDevPorts()
const apiUrl = `http://127.0.0.1:${api}`
const adminUrl = `http://127.0.0.1:${admin}`
const rowSelector = (id) => `[data-finder-tree-row="true"][data-finder-row="${id}"]`

const loginResponse = await fetch(`${apiUrl}/api/auth/dev-login`)
assert.equal(loginResponse.status, 200, 'local dev login is available')
const token = (await loginResponse.json()).data.token
const read = async (path) => {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200, `${path} loads`)
  return (await response.json()).data
}

const root = await read('/api/knowledge-base/root')
const spaces = [
  { name: 'My Documents', space: root.myDocuments },
  ...root.projects.map(({ projectName, space }) => ({ name: `Project: ${projectName}`, space })),
  ...root.shared.map((space) => ({ name: `Space: ${space.name}`, space })),
]
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript((value) => localStorage.setItem('nessie.admin.token', value), token)
const treeRow = (id, selected = false) => page.locator('.knowledge-sidebar-tree-panel').first()
  .locator(`${rowSelector(id)}${selected ? '[aria-selected="true"]' : ''}`)
const checked = []
let nestedDeepLink
let folderDetailPath

const selectedContrast = async (row) => row.evaluate((element) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  const sample = (color, base = '#ffffff') => {
    context.fillStyle = base
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const luminance = (rgb) => rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const background = sample(getComputedStyle(element).backgroundColor)
  const foreground = sample(getComputedStyle(element.querySelector('.finder-row-title')).color)
  const levels = [luminance(background), luminance(foreground)].sort((a, b) => b - a)
  return (levels[0] + 0.05) / (levels[1] + 0.05)
})

const assertTree = async (label) => {
  await page.locator('.knowledge-sidebar-tree-panel').first().waitFor()
  assert.equal(new URL(page.url()).searchParams.get('view'), 'tree', `${label}: URL preserves Tree`)
  const viewButton = page.getByRole('button', { name: /View: Tree/ })
  assert.equal(await viewButton.count(), 1, `${label}: toolbar still says Tree`)
  assert.equal(await page.locator('[data-column-browser-track]').count(), 0, `${label}: not Columns`)
  checked.push(label)
}
const gotoTree = async (route) => {
  await page.goto(`${adminUrl}${route}${route.includes('?') ? '&' : '?'}view=tree`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('.knowledge-sidebar-tree-panel').first().waitFor()
}
const clickRow = async (id) => {
  const row = treeRow(id)
  await row.waitFor()
  await row.click()
  return row
}
const pathFor = (node, byId) => {
  const chain = [node]
  let parent = node.parentPageId ? byId.get(node.parentPageId) : undefined
  while (parent) {
    chain.unshift(parent)
    parent = parent.parentPageId ? byId.get(parent.parentPageId) : undefined
  }
  return chain
}

try {
  await gotoTree('/knowledge-base')
  await assertTree('Knowledge root')
  assert.match(await treeRow('virtual:shared').innerText(), /Shared with me/,
    'root navigation offers Shared with me')

  for (const [id, label] of [
    ['virtual:latest', 'Latest'],
    ['virtual:shared', 'Shared with me'],
    ['virtual:agents', 'Agents'],
  ]) {
    await clickRow(id)
    await assertTree(label)
    await treeRow(id, true).waitFor()
    assert.ok(await selectedContrast(treeRow(id)) >= 4.5,
      `${label}: selected row meets readable text contrast`)
    if (id !== 'virtual:agents') {
      assert.equal(await page.getByRole('heading', { name: label, exact: true }).count(), 1,
        `${label}: the detail has one contextual heading`)
    }
  }

  // Agent homes are a directory destination, not a separate browser mode.
  const agentHomes = root.agentHomes ?? []
  for (const home of agentHomes) {
    await gotoTree('/knowledge-base/agents')
    await assertTree('Agents directory')
    const row = page.locator(`[data-finder-row="${home.ownerAgentId}"]`).last()
    await row.waitFor()
    await row.click()
    await assertTree(`Agent: ${home.name}`)
  }

  for (const { name, space } of spaces) {
    const route = `/knowledge-base/spaces/${encodeURIComponent(space.spaceId)}`
    await gotoTree(route)
    await assertTree(name)
    const rootRow = treeRow(space.spaceId)
    await rootRow.waitFor()
    await treeRow(space.spaceId, true).waitFor()
    assert.ok(await selectedContrast(rootRow) >= 4.5,
      `${name}: selected root meets readable text contrast`)
    // Opening an already selected space must not close its hierarchy.
    await rootRow.click()
    await assertTree(`${name} reselected`)
    const pages = await read(`/api/knowledge-base/spaces/${space.spaceId}/pages`)
    const byId = new Map(pages.map((entry) => [entry.id, entry]))
    const nestedLeaf = pages.find((entry) => entry.parentPageId && entry.kind !== 'folder')
    if (nestedLeaf && !nestedDeepLink) nestedDeepLink = { spaceId: space.spaceId, page: nestedLeaf }
    const nestedFolder = pages.find((entry) => entry.kind === 'folder'
      && entry.parentPageId && byId.get(entry.parentPageId)?.kind === 'folder')
    if (nestedFolder && !folderDetailPath) {
      folderDetailPath = {
        child: nestedFolder,
        parentPath: pathFor(byId.get(nestedFolder.parentPageId), byId),
        spaceId: space.spaceId,
      }
    }
    const firstRoot = pages.find((entry) => !entry.parentPageId)
    if (firstRoot) {
      await treeRow(firstRoot.id).waitFor()
    }
    for (const folder of pages.filter((entry) => entry.kind === 'folder')) {
      await gotoTree(route)
      for (const ancestor of pathFor(folder, byId)) {
        await clickRow(ancestor.id)
      }
      await assertTree(`${name} / ${folder.title}`)
      await treeRow(folder.id, true).waitFor()
      assert.ok(await selectedContrast(treeRow(folder.id)) >= 4.5,
        `${folder.title}: selected folder meets readable text contrast`)
    }
    for (const kind of ['document', 'file', 'spreadsheet']) {
      const leaf = pages.find((entry) => entry.kind === kind)
      if (!leaf) continue
      await gotoTree(route)
      const path = pathFor(leaf, byId)
      for (const ancestor of path) await clickRow(ancestor.id)
      await assertTree(`${name} / ${kind}`)
      await treeRow(leaf.id, true).waitFor()
      assert.ok(await selectedContrast(treeRow(leaf.id)) >= 4.5,
        `${leaf.title}: selected leaf meets readable text contrast`)
      if (kind === 'file' && /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(leaf.title)) {
        assert.equal(await treeRow(leaf.id).locator('svg[data-icon="file-image"]').count(), 1,
          `${leaf.title}: image has an image icon`)
      }
    }
    console.log(`${name}: ${pages.length} pages, ${pages.filter((entry) => entry.kind === 'folder').length} folders`)
  }
  if (nestedDeepLink) {
    const { page: document, spaceId } = nestedDeepLink
    await page.goto(`${adminUrl}/knowledge-base/spaces/${spaceId}?view=tree&pageId=${document.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await treeRow(document.id, true).waitFor()
    await assertTree('Nested document deep link')
  }
  if (folderDetailPath) {
    const { child, parentPath, spaceId } = folderDetailPath
    await gotoTree(`/knowledge-base/spaces/${spaceId}`)
    for (const ancestor of parentPath) await clickRow(ancestor.id)
    const detailRow = page.locator('.knowledge-sidebar-tree-panel').last().locator(rowSelector(child.id))
    await detailRow.click()
    await treeRow(child.id, true).waitFor()
    await assertTree('Folder child opened from detail pane')
  }
  await page.screenshot({ path: '/private/tmp/nessie-tree-ux-final.png', fullPage: true })
  console.log(`Knowledge Tree UX audit passed: ${checked.length} route/selection checks, ${spaces.length} spaces, ${agentHomes.length} agent homes`)
} finally {
  await browser.close()
}
