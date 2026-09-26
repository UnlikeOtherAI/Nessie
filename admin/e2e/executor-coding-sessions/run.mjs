import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  EXISTING_CODING_SESSION_OWNER_KEY,
  ExecutorAccessViewResponseSchema,
  ExecutorCodingSessionCloseBodySchema,
  ExecutorCodingSessionListResponseSchema,
} from '@nessie/schemas'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The coding sessions open on a machine, as the people who manage it see
 * them (docs/executor-protocol/host-coding-sessions.md → "The executor page"):
 *
 * 1. The machine's Local apps section lists each open session under the
 *    coding bridge's status — title, status, coding agent, folder, the agent
 *    driving it (or that the reader cannot see it) and when it was updated.
 * 2. The person who paired the machine has Close on every row. Close posts
 *    exactly `{ownerKey, sessionId}` for that row, the row reads "Closing…"
 *    and loses its Close, and it goes once a later answer — the machine's
 *    next report — no longer carries it.
 * 3. Another administrator of the same machine sees the list and no Close,
 *    and is told who can.
 * 4. On a phone every row and its Close fit the width; a Close the API
 *    refuses because the session already left the report says so, and the
 *    list is read again.
 * 5. A report whose bridge was not asked for its sessions says exactly that,
 *    and the page asks the API nothing.
 * 6. A ticket's own session links its ticket and says whose standing access
 *    it runs under; one whose ticket this reader cannot open says only that a
 *    ticket's work runs there, with no link. Close is the same on both.
 *
 * Every API answer is the runner's, so this pins what is drawn for each
 * answer; which answer a person gets is `api/test/executor-coding-session-routes.test.ts`.
 */

const executorId = '33333333-3333-4333-8333-333333333333'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerId = '11111111-1111-4111-8111-111111111111'
const now = Date.now()
const iso = (offsetMs) => new Date(now + offsetMs).toISOString()
const ownerKey = (letter) => `sha256:${letter.repeat(64)}`

const executor = {
  id: executorId, label: 'Workstation', profiles: ['workspace_sandbox'], status: 'online',
  scope: { kind: 'private', organizationId }, authorizationRevision: 1,
  createdAt: iso(-30 * 24 * 60 * 60_000), updatedAt: iso(-60_000), lastSeenAt: iso(-20_000),
}

const reported = [
  {
    sessionId: '99999999-9999-4999-8999-999999999991', ownerKey: ownerKey('a'), title: 'Fix the pricing page',
    status: 'working', agent: 'claude', root: 'nessie', updatedAt: iso(-60_000),
  },
  {
    sessionId: '99999999-9999-4999-8999-999999999992', ownerKey: ownerKey('b'),
    title: 'Summarise the benchmark results for the weekly report', status: 'waiting_for_input', agent: 'claude',
    root: 'nessie', updatedAt: iso(-7 * 60_000),
  },
  {
    sessionId: '99999999-9999-4999-8999-999999999993', ownerKey: ownerKey('c'), title: 'Migrate the billing tables',
    status: 'interrupted', reason: 'host_lost', agent: 'codex', root: 'billing', updatedAt: iso(-3 * 60 * 60_000),
  },
]
const [pricing, benchmarks, billing] = reported

const access = ExecutorAccessViewResponseSchema.parse({
  executorId, canManage: true,
  effectiveAccess: { privateAssignment: 'admin', projectRole: null, organizationRole: 'member' },
  privateAssignments: [{ principalKind: 'user', userId: ownerId, role: 'admin' }], operationGrants: [], sessions: [],
  descriptorRevisions: [{
    codingSessions: {
      agents: ['claude', 'codex'], allowedToolCount: 3, configDigest: `sha256:1a2b3c4d5e6f${'0'.repeat(52)}`,
      environmentNames: [], permissionMode: { claude: 'acceptEdits', codex: 'fullAuto' },
      rootNames: ['billing', 'nessie'], serverName: 'coding-sessions',
    },
    localPolicyDigest: `sha256:${'e'.repeat(64)}`,
    mcpServers: ['coding-sessions'],
    operationKeys: ['mcp.tools', 'mcp.call'],
    profiles: ['workspace_sandbox'],
    reviewStatus: 'active',
    revision: 4,
    workspaceFolders: ['projects'],
  }],
  localMcp: [{
    available: true, codingSessions: reported, observedAt: iso(-2 * 60_000), server: 'coding-sessions', toolCount: 8,
  }],
  localMcpObservedAt: iso(-2 * 60_000),
})

// Two sessions a ticket's work started under its trigger's standing access:
// one whose ticket this reader can open, and one whose project they cannot read.
const projectId = '77777777-7777-4777-8777-777777777777'
const taskId = '88888888-8888-4888-8888-888888888888'
const ticketSessions = [
  {
    sessionId: '99999999-9999-4999-8999-999999999994', ownerKey: ownerKey('d'), title: 'Fix the invoice rounding',
    status: 'working', agent: 'claude', root: 'billing', updatedAt: iso(-2 * 60_000),
  },
  {
    sessionId: '99999999-9999-4999-8999-999999999995', ownerKey: ownerKey('f'), title: 'Update the release checklist',
    status: 'waiting_for_input', agent: 'claude', root: 'nessie', updatedAt: iso(-12 * 60_000),
  },
]
const [invoice, checklist] = ticketSessions
const ticketTitle = 'NES-42 Fix the invoice rounding'
const ticketWork = {
  [invoice.sessionId]: { authorName: 'Ondrej', ticket: { taskId, projectId, title: ticketTitle } },
  [checklist.sessionId]: { authorName: 'Ondrej', ticket: null },
}
const ticketAccess = ExecutorAccessViewResponseSchema.parse({
  ...access, localMcp: [{ ...access.localMcp[0], codingSessions: ticketSessions }],
})

const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-coding-sessions')

/**
 * One browser context whose API is this closure. `canClose` and the names are
 * the only things the pairing owner's answer and another administrator's
 * differ in; a Close marks its row closing, and `dropClosing()` is the
 * machine's next report arriving without it.
 */
const openContext = async (browser, {
  accessView = access, canClose, names, refuse = [], sessions = reported, ticketWork: ticketOf = {}, width, viewSession = pricing,
}) => {
  const state = {
    closing: new Set(), dropped: new Set(), posted: [], reads: 0, viewers: [],
    screen: 'Claude is working', revoked: false,
  }
  const unexpected = []
  const context = await browser.newContext({ hasTouch: width < 768, viewport: { width, height: 900 } })
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    const respond = (data, status = 200) => route.fulfill({ status, json: { data } })
    const sessionBase = `/api/executors/${executorId}/coding-sessions/${viewSession.sessionId}`
    if (path === sessionBase + '/view') {
      if (state.revoked) return respond(null, 404)
      const session = { ...viewSession }
      delete session.ownerKey
      return respond({
        canShare: canClose && viewSession.origin !== 'external', online: true, session,
        screen: { ansi: '\u001b[32m' + state.screen + '\u001b[0m\r\n> ', cols: 120, rows: 36,
          capturedAt: iso(0), kind: 'terminal' },
      })
    }
    if (path === sessionBase + '/shares') {
      if (method === 'POST') state.viewers.push({
        userId: ownerId, email: route.request().postDataJSON().email, displayName: 'A colleague',
      })
      return respond(method === 'GET' ? state.viewers : { success: true })
    }
    if (path === sessionBase + '/shares/' + ownerId && method === 'DELETE') {
      state.viewers = []
      return respond({ success: true })
    }
    if (path === '/api/executor-sessions') {
      return respond(sessions.map((entry) => {
        const session = { ...entry }
        delete session.ownerKey
        return { ...session, executorId, executorLabel: 'Workstation', shared: !canClose }
      }))
    }
    if (path === '/api/executors') return respond([executor])
    if (path === `/api/executors/${executorId}/access`) return respond(accessView)
    if (path === `/api/executors/${executorId}/coding-sessions` && method === 'GET') {
      state.reads += 1
      return respond(ExecutorCodingSessionListResponseSchema.parse({
        canClose,
        sessions: sessions.filter((session) => !state.dropped.has(session.sessionId)).map((session) => ({
          ...session, closing: state.closing.has(session.sessionId), ownerAgentName: names[session.sessionId] ?? null,
          ...(ticketOf[session.sessionId] ? { ticketWork: ticketOf[session.sessionId] } : {}),
        })),
      }))
    }
    if (path === `/api/executors/${executorId}/coding-sessions/close` && method === 'POST') {
      const body = ExecutorCodingSessionCloseBodySchema.parse(route.request().postDataJSON())
      state.posted.push(body)
      if (refuse.includes(body.sessionId)) {
        state.dropped.add(body.sessionId)
        return route.fulfill({ status: 404, json: { error: {
          code: 'EXECUTOR_CODING_SESSION_NOT_FOUND', message: 'That coding session is no longer open on this machine.',
        } } })
      }
      state.closing.add(body.sessionId)
      return respond({ closing: true, sessionId: body.sessionId }, 202)
    }
    if (path === '/api/local-inference/hosts') return respond({ hosts: [], meta: { total: 0 } })
    unexpected.push(`${method} ${path}`)
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const dropClosing = () => { for (const id of state.closing) state.dropped.add(id) }
  return { context, dropClosing, errors, page, state, unexpected }
}

const open = async (page) => {
  await page.goto(`${ADMIN_URL}/e2e/executor-coding-sessions/index.html`)
  await page.getByRole('heading', { name: 'Workstation' }).waitFor()
  const list = page.getByRole('list', { name: 'Open coding sessions' })
  await list.waitFor()
  return list
}

const rowOf = (list, session) => list.getByTestId('executor-coding-session').filter({ hasText: session.title })
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

const ownerNames = { [pricing.sessionId]: 'CTO', [benchmarks.sessionId]: 'Researcher' }

await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const served = await fetch(ADMIN_URL).then((r) => r.text())
  if (process.env.NAV_E2E_ADMIN_MODE !== 'preview') assert.ok(served.includes('@vite/client'))
  await mkdir(output, { recursive: true })

  // The pairing owner, on a desktop.
  const owner = await openContext(browser, { canClose: true, names: ownerNames, width: 1280 })
  const list = await open(owner.page)
  assert.equal(await list.getByTestId('executor-coding-session').count(), 3)
  const section = owner.page.getByText('Coding sessions', { exact: true })
  assert.equal(await section.count(), 1, 'the bridge is named for a person, not by its server name')
  assert.match(await rowOf(list, pricing).innerText(),
    /Fix the pricing page\s*working\s*Claude Code in nessie · driven by CTO · updated 1 min ago/)
  assert.match(await rowOf(list, benchmarks).innerText(), /waiting for input[\s\S]*driven by Researcher/)
  assert.match(await rowOf(list, billing).innerText(),
    /interrupted\s*host lost\s*Codex in billing · driven by an agent you cannot see · updated 3 h ago/)
  assert.equal(await list.getByRole('button', { name: /^Close / }).count(), 3, 'the pairing owner may close each one')
  assert.equal(await owner.page.getByText('Only the person who paired this machine', { exact: false }).count(), 0)
  await owner.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'owner-list-1280.png') })

  await list.getByRole('link', { name: `View ${pricing.title}` }).click()
  await owner.page.getByTestId('executor-terminal-screen').waitFor()
  await owner.page.getByText('Claude is working', { exact: false }).first().waitFor()
  owner.state.screen = 'Claude finished the check'
  await owner.page.getByText('Claude finished the check', { exact: false }).first().waitFor()
  await owner.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'terminal-1280.png') })
  await owner.page.getByRole('button', { name: 'Share session', exact: true }).click()
  await owner.page.getByLabel('User’s email').fill('colleague@example.test')
  await owner.page.getByRole('button', { name: 'Add viewer' }).click()
  await owner.page.getByText('colleague@example.test', { exact: true }).waitFor()
  await owner.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'session-sharing.png') })
  await owner.page.getByRole('button', { name: 'Remove', exact: true }).click()
  await owner.page.getByText('Only you can view this session.', { exact: true }).waitFor()
  await owner.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await open(owner.page)

  await list.getByRole('button', { name: `Close ${pricing.title}` }).click()
  await rowOf(list, pricing).getByTestId('executor-coding-session-closing').waitFor()
  assert.deepEqual(owner.state.posted, [{ ownerKey: pricing.ownerKey, sessionId: pricing.sessionId }],
    'Close posts that row’s owner key and session, and nothing else')
  assert.equal(await rowOf(list, pricing).getByRole('button', { name: /^Close / }).count(), 0, 'a closing row has no Close')
  assert.equal(await list.getByRole('button', { name: /^Close / }).count(), 2, 'the other rows keep theirs')
  await owner.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'owner-closing-1280.png') })

  // The machine's next report no longer carries it: the list is read again
  // while a Close waits, and the row goes without anyone reloading.
  const readsBefore = owner.state.reads
  const refreshed = owner.page.waitForResponse((response) =>
    response.url().endsWith(`/api/executors/${executorId}/coding-sessions`)
      && response.request().method() === 'GET', { timeout: 30_000 })
  owner.dropClosing()
  await refreshed
  await rowOf(list, pricing).waitFor({ state: 'detached', timeout: 30_000 })
  assert.ok(owner.state.reads > readsBefore)
  assert.equal(await list.getByTestId('executor-coding-session').count(), 2)
  await owner.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'owner-closed-1280.png') })
  assert.deepEqual(owner.errors, [])
  assert.deepEqual(owner.unexpected, [])
  await owner.context.close()

  // Another administrator of the same machine: the list, no Close, and why.
  const coadmin = await openContext(browser, {
    canClose: false, names: { [benchmarks.sessionId]: 'Researcher' }, width: 1280,
  })
  const theirs = await open(coadmin.page)
  assert.equal(await theirs.getByTestId('executor-coding-session').count(), 3)
  assert.equal(await coadmin.page.getByRole('button', { name: /^Close / }).count(), 0, 'no Close for anyone else')
  await coadmin.page.getByText(
    'Only the person who paired this machine can close its coding sessions; they run as that person.',
  ).waitFor()
  assert.match(await rowOf(theirs, pricing).innerText(), /driven by an agent you cannot see/)
  await coadmin.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'administrator-1280.png') })
  assert.deepEqual(coadmin.errors, [])
  assert.deepEqual(coadmin.unexpected, [])
  await coadmin.context.close()

  // The pairing owner, on a phone.
  const phone = await openContext(browser, {
    canClose: true, names: ownerNames, refuse: [billing.sessionId], width: 390,
  })
  const small = await open(phone.page)
  for (const session of reported) {
    const box = await small.getByRole('button', { name: `Close ${session.title}` }).boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `Close for "${session.title}" is on screen`)
  }
  assert.ok(await noOverflow(phone.page), 'No page overflow')
  // The page scrolls inside its own column, so the shot brings the list to it.
  await small.scrollIntoViewIfNeeded()
  await phone.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'owner-list-390.png') })
  await small.getByRole('button', { name: `Close ${benchmarks.title}` }).click()
  await rowOf(small, benchmarks).getByTestId('executor-coding-session-closing').waitFor()
  // A session the machine already dropped: the refusal is said, and the list re-read drops it too.
  await small.getByRole('button', { name: `Close ${billing.title}` }).click()
  await phone.page.getByText('That coding session is no longer open on this machine.').waitFor()
  await rowOf(small, billing).waitFor({ state: 'detached' })
  assert.deepEqual(phone.state.posted.map((body) => body.sessionId), [benchmarks.sessionId, billing.sessionId])
  assert.ok(await noOverflow(phone.page), 'No page overflow')
  await small.scrollIntoViewIfNeeded()
  await phone.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'owner-closing-390.png') })
  assert.deepEqual(phone.errors, [])
  assert.deepEqual(phone.unexpected, [])
  await phone.context.close()

  // A daemon that has not asked its bridge yet: that says nothing about what
  // is open, so the section says so and asks the API nothing.
  const unasked = await openContext(browser, {
    accessView: ExecutorAccessViewResponseSchema.parse({
      ...access,
      localMcp: [{ available: true, observedAt: iso(-60_000), server: 'coding-sessions', toolCount: 8 }],
    }),
    canClose: true, names: ownerNames, width: 1280,
  })
  await unasked.page.goto(`${ADMIN_URL}/e2e/executor-coding-sessions/index.html`)
  await unasked.page.getByText('Open coding sessions have not been checked yet.').waitFor()
  assert.equal(unasked.state.reads, 0, 'nothing to list, nothing asked')
  await unasked.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, 'not-asked-1280.png') })
  assert.deepEqual(unasked.errors, [])
  assert.deepEqual(unasked.unexpected, [])
  await unasked.context.close()

  // A ticket's own sessions: the ticket linked where this reader can open it,
  // whose standing access the work runs under, and the same Close as any other.
  for (const width of [1280, 390]) {
    const tickets = await openContext(browser, {
      accessView: ticketAccess, canClose: true, names: { [invoice.sessionId]: 'CTO', [checklist.sessionId]: 'CTO' },
      sessions: ticketSessions, ticketWork, width,
    })
    const listed = await open(tickets.page)
    assert.equal(await listed.getByTestId('executor-coding-session').count(), 2)
    const linked = rowOf(listed, invoice)
    assert.match(await linked.innerText(),
      /Fix the invoice rounding\s*working\s*Claude Code in billing · driven by CTO/)
    const link = linked.getByRole('link', { name: ticketTitle })
    assert.equal(await link.getAttribute('href'), `/projects/${projectId}/board?task=${taskId}`,
      'the ticket opens on its own board')
    assert.equal((await linked.getByTestId('executor-coding-session-ticket').innerText()).trim(),
      `${ticketTitle} · ticket work under Ondrej’s standing access`)
    const unlinked = rowOf(listed, checklist)
    assert.equal((await unlinked.getByTestId('executor-coding-session-ticket').innerText()).trim(),
      'A ticket’s work under Ondrej’s standing access')
    // The row keeps its View session link; the ticket line itself links nowhere.
    assert.equal(await unlinked.getByTestId('executor-coding-session-ticket').getByRole('link').count(), 0,
      'a ticket this reader cannot open is not linked')
    assert.equal(await unlinked.getByRole('link', { name: `View ${checklist.title}` }).count(), 1)
    assert.equal(await listed.getByRole('button', { name: /^Close / }).count(), 2, 'ticket sessions keep their Close')
    const box = await link.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, 'the ticket link is on screen')
    assert.ok(await noOverflow(tickets.page), 'No page overflow')
    await listed.scrollIntoViewIfNeeded()
    await tickets.page.screenshot({ animations: 'disabled', fullPage: true, path: resolve(output, `ticket-work-${width}.png`) })
    assert.deepEqual(tickets.errors, [])
    assert.deepEqual(tickets.unexpected, [])
    await tickets.context.close()
  }

  // A shared recipient reaches the same viewer without any machine-management reads.
  const recipient = await openContext(browser, { canClose: false, names: {}, width: 390 })
  await recipient.page.goto(`${ADMIN_URL}/e2e/executor-coding-sessions/index.html?sessions=1`)
  await recipient.page.getByRole('link', { name: new RegExp(pricing.title) }).click()
  await recipient.page.getByTestId('executor-terminal-screen').waitFor()
  assert.equal(await recipient.page.getByRole('button', { name: 'Share session', exact: true }).count(), 0)
  assert.equal(recipient.state.reads, 0, 'a shared recipient never reads the machine session roster')
  assert.ok(await noOverflow(recipient.page), 'the terminal scrolls internally on a phone')
  await recipient.page.screenshot({ fullPage: true, path: resolve(output, 'shared-terminal-390.png') })
  recipient.state.revoked = true
  await recipient.page.getByText('This session is unavailable or you no longer have permission to view it.',
    { exact: false }).waitFor()
  assert.equal(await recipient.page.getByTestId('executor-terminal-screen').count(), 0, 'revocation hides cached output')
  assert.deepEqual(recipient.errors, [])
  assert.deepEqual(recipient.unexpected, [])
  await recipient.context.close()

  for (const width of [1280, 390]) {
    const existing = { ...pricing, sessionId: '99999999-9999-5999-a999-999999999999',
      ownerKey: EXISTING_CODING_SESSION_OWNER_KEY, origin: 'external', agent: 'codex', root: 'existing',
      status: 'unknown', title: 'Existing Codex conversation' }
    const native = await openContext(browser, { canClose: true, names: {}, width,
      sessions: [existing], viewSession: existing })
    const nativeList = await open(native.page)
    assert.match(await nativeList.innerText(), /existing native session/u)
    assert.equal(await nativeList.getByRole('button', { name: /^Close /u }).count(), 0)
    await nativeList.getByRole('link', { name: `View ${existing.title}` }).click()
    await native.page.getByText('Existing native session · Ask your Nessie agent to inspect it or send input').waitFor()
    assert.equal(await native.page.getByRole('button', { name: 'Share session', exact: true }).count(), 0)
    await native.page.reload()
    await native.page.getByRole('heading', { name: existing.title }).waitFor()
    assert.equal(await noOverflow(native.page), true)
    await native.page.screenshot({ fullPage: true, path: resolve(output, `existing-session-${width}.png`) })
    await native.page.getByRole('button', { name: 'Back to sessions' }).click()
    await native.page.goBack()
    await native.page.getByRole('heading', { name: existing.title }).waitFor()
    assert.deepEqual(native.errors, [])
    assert.deepEqual(native.unexpected, [])
    await native.context.close()
  }
  console.log(`Executor coding sessions flows passed; screenshots: ${output}`)
} finally { await browser.close(); await stopProcess(admin) }
