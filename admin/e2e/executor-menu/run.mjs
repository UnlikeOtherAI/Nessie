import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, adminMode } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const organizationId = '22222222-2222-4222-8222-222222222222'
const record = (number, kind = 'private') => ({
  id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`, label: `Machine ${number}`,
  scope: { kind, organizationId }, profiles: [], authorizationRevision: 1, status: 'online',
  createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
})
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-menu')
await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  if (adminMode() !== 'preview') assert.ok((await fetch(ADMIN_URL).then((r) => r.text())).includes('@vite/client'))
  await mkdir(output, { recursive: true })
  for (const topbar of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: topbar ? 1024 : 1280, height: 900 }, hasTouch: topbar,
    })
    let machines = [record(1), record(2), record(3, 'organization')]
    let reads = 0
    let socket
    let socketCount = 0
    await context.route('**/api/executors', (route) => { reads += 1; return route.fulfill({ json: { data: machines } }) })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.routeWebSocket('**/api/activity*', (ws) => {
      socket = ws
      socketCount += 1
      ws.onMessage((raw) => {
        const message = JSON.parse(raw)
        if (message.type === 'set_subscriptions') {
          assert.ok(message.scopes.some((scope) => scope.kind === 'executor_inventory'))
          ws.send(JSON.stringify({ type: 'subscribed', scopes: message.scopes, snapshot: { agents: [] } }))
        }
      })
    })
    await page.goto(`${ADMIN_URL}/e2e/executor-menu/index.html${topbar ? '?topbar' : ''}`)
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('img', { name: 'All executors online' }).first().waitFor()
    await page.getByRole('button', { name: 'Show personal executors' }).click()
    const menu = page.getByRole('menu', { name: 'Personal executors', exact: true })
    await menu.waitFor()
    const bounds = await menu.boundingBox()
    const parent = await page.getByRole('menu', { name: 'Account menu', exact: true }).boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (topbar ? 1024 : 1280))
    assert.ok(topbar ? bounds.x + bounds.width < parent.x : bounds.x > parent.x + parent.width,
      'submenu opens into available space, away from the window edge')
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
    })
    await page.screenshot({ path: resolve(output, topbar ? 'ipad-top-right.png' : 'desktop-left.png') })
    await page.keyboard.press('Escape')
    assert.equal(await menu.count(), 0)
    assert.equal(await page.getByRole('menu', { name: 'Account menu', exact: true }).count(), 1)
    assert.ok(await page.getByRole('button', { name: 'Show personal executors' }).evaluate(
      (element) => element === document.activeElement,
    ))
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: /Machine 1/ }).click()
    await page.waitForURL(`**/agents/executors/${machines[0].id}`)
    assert.equal(await page.getByRole('menu').count(), 0)
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    const before = reads
    const send = (index, status) => {
      machines = machines.map((machine, i) => i === index
        ? { ...machine, status, updatedAt: new Date().toISOString() } : machine)
      const machine = machines[index]
      socket.send(JSON.stringify({ type: 'event', event: 'executor.status.changed', ts: machine.updatedAt,
        data: { executorId: machine.id, status, lastSeenAt: null, statusDetail: null,
          updatedAt: machine.updatedAt, removed: false } }))
    }
    send(0, 'offline')
    await page.getByRole('img', { name: 'Some executors offline' }).waitFor()
    await page.getByRole('list', { name: 'Inventory' }).getByText('Machine 1: offline', { exact: true }).waitFor()
    send(1, 'offline')
    await page.getByRole('img', { name: 'All executors offline' }).waitFor()
    assert.equal(reads, before, 'status frames update the screen directly, without a REST refresh')
    assert.equal(socketCount, 1, 'the menu and page share one socket')
    await page.getByRole('menuitem', { name: 'Executors', exact: true }).click()
    await page.waitForURL('**/agents/executors')
    machines = []
    socket.send(JSON.stringify({ type: 'event', event: 'executor.inventory.changed', ts: new Date().toISOString(), data: {} }))
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add Personal Executor' }).waitFor()
    assert.equal(await page.getByRole('button', { name: /Show .* executors/ }).count(), 0)
    assert.equal(await page.getByRole('img', { name: 'No executors' }).count(), 2)
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
    })
    await page.screenshot({ path: resolve(output, topbar ? 'ipad-empty.png' : 'desktop-empty.png') })
    await page.getByRole('menuitem', { name: 'Add Team Executor' }).click()
    await page.waitForURL('**/agents/executors?create=team')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add Personal Executor' }).click()
    await page.waitForURL('**/agents/executors?create=personal')
    // A missed update while disconnected is recovered by the reconnect handshake.
    machines = [record(1)]
    socket.close()
    await page.getByRole('list', { name: 'Inventory' }).getByText('Machine 1: online', { exact: true }).waitFor()
    assert.equal(socketCount, 2)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('Executor menus, live statuses, reconnect, navigation and empty actions passed.')
} finally {
  await browser.close()
  await stopProcess(admin)
}
