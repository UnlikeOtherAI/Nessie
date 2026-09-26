import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ExecutorAccessViewResponseSchema,
  ExecutorConversationLeaseRecordSchema,
  ExecutorMachineLeaseRecordSchema,
} from '@nessie/schemas'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The executor conversation lease, as the people it concerns see it
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §4):
 *
 * 1. The holder sees "Minis · local apps · until HH:MM · End" beside Run on a
 *    computer once the composer opens — and the composer at rest is still
 *    exactly one line, lease or no lease.
 * 2. Another member of the same room, asking about the same thread, is
 *    answered with nothing and sees nothing.
 * 3. End posts to the lease's own route and the indicator goes.
 * 4. On a phone the toolbar has no room: the chip folds into a dot on Run on
 *    a computer, and the launcher dialog carries the lease and its End.
 * 5. A chip stands only beside a composer whose messages would carry it. A
 *    launch in a conversation with the agent covers the whole thread, so the
 *    main composer shows it (1–4). A launch in an ordinary room covers only
 *    its own reply thread: the room's composer shows nothing, that reply
 *    thread's composer shows the chip — at a phone's width too, since it has
 *    no Run on a computer to fold into — and any other reply thread nothing.
 * 6. The computer's detail page lists its live leases (agent, conversation,
 *    person, last used) with End, and says so where it may not name one.
 *
 * Every API answer is the runner's, so this pins what is drawn for each
 * answer; which answer a person gets is the API route tests' job.
 */

const threadId = '66666666-6666-4666-8666-666666666666'
const executorId = '33333333-3333-4333-8333-333333333333'
const agentId = '77777777-7777-4777-8777-777777777777'
const holderId = '11111111-1111-4111-8111-111111111111'
const otherHolderId = '88888888-8888-4888-8888-888888888888'
const organizationId = '22222222-2222-4222-8222-222222222222'
const channelId = '55555555-5555-4555-8555-555555555555'
const now = Date.now()
const iso = (offsetMs) => new Date(now + offsetMs).toISOString()

// Launched in a conversation with the agent, where the whole thread carries
// it — so the main composer is where it belongs.
const ownLease = ExecutorConversationLeaseRecordSchema.parse({
  id: '99999999-9999-4999-8999-999999999991', agentId, executorLabel: 'Minis', threadId,
  rootMessageId: '99999999-9999-4999-8999-999999999990', wholeThread: true,
  launchedAt: iso(-30 * 60_000), expiresAt: iso(95 * 60_000),
})
// Launched in an ordinary room: only replies under the launch message carry
// it, so it belongs to that reply thread's composer and to no other.
const launchRootId = '99999999-9999-4999-8999-999999999993'
const roomLease = ExecutorConversationLeaseRecordSchema.parse({
  ...ownLease, id: '99999999-9999-4999-8999-999999999994', rootMessageId: launchRootId, wholeThread: false,
})
const machineLeases = [
  ExecutorMachineLeaseRecordSchema.parse({
    id: ownLease.id, agent: { id: agentId, name: 'CTO' }, holderUserId: holderId,
    conversation: { channelId, threadId, label: 'launch' },
    launchedAt: ownLease.launchedAt, lastUsedAt: iso(-5 * 60_000), expiresAt: ownLease.expiresAt,
  }),
  ExecutorMachineLeaseRecordSchema.parse({
    id: '99999999-9999-4999-8999-999999999992', agent: { id: '77777777-7777-4777-8777-777777777778', name: null },
    holderUserId: otherHolderId,
    conversation: null,
    launchedAt: iso(-2 * 60 * 60_000), lastUsedAt: iso(-40 * 60_000), expiresAt: iso(80 * 60_000),
  }),
]
const timestamp = iso(-24 * 60 * 60_000)
const executor = {
  id: executorId, label: 'Minis', profiles: ['workspace_sandbox'], status: 'online',
  scope: { kind: 'organization', organizationId }, authorizationRevision: 1,
  createdAt: timestamp, updatedAt: timestamp, lastSeenAt: iso(-60_000),
}
const access = ExecutorAccessViewResponseSchema.parse({
  executorId, canManage: true,
  effectiveAccess: { privateAssignment: 'none', projectRole: null, organizationRole: 'owner' },
  privateAssignments: [], operationGrants: [], descriptorRevisions: [], sessions: [],
})
const users = [
  { id: holderId, displayName: 'Ondrej' },
  { id: otherHolderId, displayName: 'Katerina' },
]

const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-lease')

/**
 * One browser context whose API is this closure. `leases` is the answer to
 * the composer's lease read — the only thing that differs between the holder
 * and another member.
 */
const openContext = async (browser, { leases, width }) => {
  const state = { leases: [...leases], machine: [...machineLeases], ended: [], leaseReads: [] }
  const unexpected = []
  const context = await browser.newContext({ hasTouch: width < 768, viewport: { width, height: 820 } })
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    const respond = (data) => route.fulfill({ json: { data } })
    // The session provider asks who is signed in; the fixture is nobody,
    // which also keeps the shared event stream closed.
    if (path.startsWith('/api/auth/')) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'fixture' } } })
    if (path === '/api/executor-leases' && method === 'GET') {
      state.leaseReads.push(url.searchParams.get('threadId'))
      return respond(state.leases)
    }
    const ending = path.match(/^\/api\/executor-leases\/([^/]+)\/end$/)
    if (ending && method === 'POST') {
      state.ended.push(ending[1])
      state.leases = state.leases.filter((lease) => lease.id !== ending[1])
      state.machine = state.machine.filter((lease) => lease.id !== ending[1])
      return respond({ ended: true, leaseId: ending[1] })
    }
    if (path === '/api/executor-availability') return respond({ candidates: [], explanations: [] })
    if (path === '/api/executors') return respond([executor])
    if (path === `/api/executors/${executorId}/access`) return respond(access)
    if (path === `/api/executors/${executorId}/leases`) return respond(state.machine)
    if (path === '/api/users') return respond(users)
    if (path === '/api/agents') return respond([])
    if (path === '/api/local-inference/hosts') return respond({ hosts: [], meta: { total: 0 } })
    unexpected.push(`${method} ${path}`)
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, errors, page, state, unexpected }
}

const composerHeight = (page) => page.locator('form.admin-compose').evaluate((form) => form.getBoundingClientRect().height)
const expandComposer = async (page) => {
  await page.locator('form.admin-compose [contenteditable="true"]').click()
  await page.locator('form.admin-compose[data-expanded="true"]').waitFor()
}
const settle = (page) => page.waitForLoadState('networkidle')

await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const served = await fetch(ADMIN_URL).then((r) => r.text())
  if (process.env.NAV_E2E_ADMIN_MODE !== 'preview') assert.ok(served.includes('@vite/client'))
  await mkdir(output, { recursive: true })
  const composerUrl = `${ADMIN_URL}/e2e/executor-lease/index.html?view=composer`

  // Another member of the room: the same thread, an empty answer, no chip.
  const member = await openContext(browser, { leases: [], width: 1280 })
  await member.page.goto(composerUrl)
  await member.page.locator('form.admin-compose').waitFor()
  await settle(member.page)
  assert.deepEqual([...new Set(member.state.leaseReads)], [threadId], 'the composer asks about its own thread')
  const restHeight = await composerHeight(member.page)
  await expandComposer(member.page)
  await member.page.getByRole('button', { name: 'Run on a computer' }).waitFor()
  assert.equal(await member.page.getByTestId('executor-lease-indicator').count(), 0, 'another member sees no lease')
  await member.page.screenshot({ animations: 'disabled', path: resolve(output, 'member-no-indicator-1280.png') })
  assert.deepEqual(member.errors, [])
  assert.deepEqual(member.unexpected, [])
  await member.context.close()

  // The holder, on a desktop.
  const holder = await openContext(browser, { leases: [ownLease], width: 1280 })
  await holder.page.goto(composerUrl)
  await holder.page.locator('form.admin-compose').waitFor()
  await settle(holder.page)
  const indicator = holder.page.getByTestId('executor-lease-indicator')
  assert.equal(await indicator.count(), 1, 'the holder has their lease on the page')
  assert.equal(await indicator.isVisible(), false, 'the composer at rest shows no toolbar and no chip')
  assert.equal(await composerHeight(holder.page), restHeight, 'a lease adds no line to the composer at rest')
  await holder.page.screenshot({ animations: 'disabled', path: resolve(output, 'holder-at-rest-1280.png') })
  await expandComposer(holder.page)
  await indicator.waitFor({ state: 'visible' })
  assert.match(await indicator.innerText(), /^Minis · local apps · until \d{1,2}:\d{2}(\s?[AP]M)?\s*End$/)
  const run = await holder.page.getByRole('button', { name: 'Run on a computer' }).boundingBox()
  const chip = await indicator.boundingBox()
  assert.ok(run && chip && chip.x >= run.x + run.width && chip.x - (run.x + run.width) < 12, 'the chip sits beside Run on a computer')
  const send = await holder.page.getByRole('button', { name: 'Send message' }).boundingBox()
  assert.ok(send && chip.x + chip.width <= send.x, 'the chip never runs under Send')
  await holder.page.screenshot({ animations: 'disabled', path: resolve(output, 'holder-indicator-1280.png') })
  await holder.page.getByRole('button', { name: 'End local apps on Minis' }).click()
  await indicator.waitFor({ state: 'detached' })
  assert.deepEqual(holder.state.ended, [ownLease.id], 'End posts for that lease and nothing else')
  await holder.page.screenshot({ animations: 'disabled', path: resolve(output, 'holder-ended-1280.png') })
  assert.deepEqual(holder.errors, [])
  assert.deepEqual(holder.unexpected, [])
  await holder.context.close()

  // The holder, on a phone: no room for the chip, a dot instead, and the
  // launcher carries the lease and its End.
  const phone = await openContext(browser, { leases: [ownLease], width: 390 })
  await phone.page.goto(composerUrl)
  await phone.page.locator('form.admin-compose').waitFor()
  await settle(phone.page)
  await expandComposer(phone.page)
  assert.equal(await phone.page.getByTestId('executor-lease-indicator').isVisible(), false, 'no chip on a phone toolbar')
  const dot = await phone.page.locator('.admin-compose-executor').evaluate((button) => getComputedStyle(button, '::after').content)
  assert.notEqual(dot, 'none', 'Run on a computer carries the dot instead')
  await phone.page.screenshot({ animations: 'disabled', path: resolve(output, 'holder-dot-390.png') })
  await phone.page.getByRole('button', { name: 'Run on a computer' }).click()
  const dialog = phone.page.getByRole('dialog', { name: 'Run on a computer' })
  const notice = dialog.getByTestId('executor-lease-launcher-notice')
  await notice.waitFor()
  assert.match(await notice.innerText(), /CTO can use local apps on Minis/)
  await phone.page.screenshot({ animations: 'disabled', path: resolve(output, 'holder-launcher-390.png') })
  await dialog.getByRole('button', { name: 'End local apps on Minis' }).click()
  await notice.waitFor({ state: 'detached' })
  assert.deepEqual(phone.state.ended, [ownLease.id])
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
  assert.deepEqual(phone.errors, [])
  assert.deepEqual(phone.unexpected, [])
  await phone.context.close()

  // A launch in an ordinary room carries only in its own reply thread: the
  // room's composer, whose posts are top-level, shows nothing — not a chip on
  // a desktop, not a dot on a phone — and the reply thread's composer carries
  // the chip and its End. Another reply thread shows nothing either.
  for (const width of [1280, 390]) {
    const room = await openContext(browser, { leases: [roomLease], width })
    await room.page.goto(composerUrl)
    await room.page.locator('form.admin-compose').waitFor()
    await settle(room.page)
    await expandComposer(room.page)
    await room.page.getByRole('button', { name: 'Run on a computer' }).waitFor()
    assert.equal(await room.page.getByTestId('executor-lease-indicator').count(), 0,
      'a top-level post would not carry the lease, so the room composer does not claim it')
    const roomDot = await room.page.locator('.admin-compose-executor').evaluate((button) => getComputedStyle(button, '::after').content)
    assert.ok(roomDot === 'none' || roomDot === 'normal', `no dot either (${roomDot})`)
    await room.page.screenshot({ animations: 'disabled', path: resolve(output, `room-composer-no-indicator-${width}.png`) })

    await room.page.goto(`${ADMIN_URL}/e2e/executor-lease/index.html?view=reply&root=99999999-9999-4999-8999-999999999995`)
    await room.page.locator('form.admin-compose').waitFor()
    await settle(room.page)
    await expandComposer(room.page)
    assert.equal(await room.page.getByTestId('executor-lease-indicator').count(), 0, 'another reply thread shows nothing')

    await room.page.goto(`${ADMIN_URL}/e2e/executor-lease/index.html?view=reply&root=${launchRootId}`)
    await room.page.locator('form.admin-compose').waitFor()
    await settle(room.page)
    const replyIndicator = room.page.getByTestId('executor-lease-indicator')
    assert.equal(await replyIndicator.isVisible(), false, 'the reply composer at rest shows no chip')
    await expandComposer(room.page)
    await replyIndicator.waitFor({ state: 'visible' })
    assert.equal(await room.page.getByRole('button', { name: 'Run on a computer' }).count(), 0)
    const replyChip = await replyIndicator.boundingBox()
    const replySend = await room.page.getByRole('button', { name: 'Send message' }).boundingBox()
    const replyEnd = await room.page.getByRole('button', { name: 'End local apps on Minis' }).boundingBox()
    const panel = await room.page.getByTestId('reply-panel').boundingBox()
    assert.ok(replyChip && replySend && replyEnd && panel)
    assert.ok(replyChip.x + replyChip.width <= replySend.x, 'the chip never runs under Send')
    assert.ok(replyEnd.x >= panel.x && replyEnd.x + replyEnd.width <= replyChip.x + replyChip.width,
      'End is inside the chip and on screen, however much of the label gives way')
    assert.match(await replyIndicator.getAttribute('title') ?? '', /^CTO can use local apps on Minis for your own messages/,
      'where the label is cut, the title still says it all')
    await room.page.screenshot({ animations: 'disabled', path: resolve(output, `room-reply-indicator-${width}.png`) })
    await room.page.getByRole('button', { name: 'End local apps on Minis' }).click()
    await replyIndicator.waitFor({ state: 'detached' })
    assert.deepEqual(room.state.ended, [roomLease.id])
    assert.ok(await room.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
    assert.deepEqual(room.errors, [])
    assert.deepEqual(room.unexpected, [])
    await room.context.close()
  }

  // The machine's own page, for someone who manages it.
  for (const width of [1280, 390]) {
    const machine = await openContext(browser, { leases: [], width })
    await machine.page.goto(`${ADMIN_URL}/e2e/executor-lease/index.html?view=executor`)
    await machine.page.getByRole('heading', { name: 'Minis' }).waitFor()
    const table = machine.page.getByRole('table', { name: 'Local apps in use' })
    await table.waitFor()
    // Below sm the conversation and the person fold into the agent cell, so
    // each is asserted where it is actually drawn at this width.
    const shown = (text) => table.getByText(text, { exact: true }).filter({ visible: true })
    await shown('CTO').waitFor()
    await table.getByRole('link', { name: 'launch' }).waitFor()
    await shown('An agent you cannot see').waitFor()
    await shown('A conversation you are not in').waitFor()
    assert.equal(await shown('A conversation you are not in').count(), 1)
    const endButton = table.getByRole('button', { name: 'End local apps for Ondrej' })
    const endBox = await endButton.boundingBox()
    assert.ok(endBox && endBox.x + endBox.width <= width, 'End is on screen without scrolling the table')
    if (width >= 768) {
      // The Person column; below sm the name folds into the agent cell instead.
      assert.equal(await table.getByTitle(holderId).innerText(), 'Ondrej')
      assert.equal(await table.getByTitle(otherHolderId).innerText(), 'Katerina')
    }
    await machine.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, `machine-leases-${width}.png`) })
    await endButton.click()
    await table.getByRole('link', { name: 'launch' }).waitFor({ state: 'detached' })
    assert.deepEqual(machine.state.ended, [ownLease.id])
    assert.ok(await machine.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
    await machine.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, `machine-lease-ended-${width}.png`) })
    assert.deepEqual(machine.errors, [])
    assert.deepEqual(machine.unexpected, [])
    await machine.context.close()
  }
  console.log(`Executor lease flows passed; screenshots: ${output}`)
} finally { await browser.close(); await stopProcess(admin) }
