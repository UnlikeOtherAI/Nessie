import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
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

const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-coding-sessions')

/**
 * One browser context whose API is this closure. `canClose` and the names are
 * the only things the pairing owner's answer and another administrator's
 * differ in; a Close marks its row closing, and `dropClosing()` is the
 * machine's next report arriving without it.
 */
const openContext = async (browser, { accessView = access, canClose, names, refuse = [], width }) => {
  const state = { closing: new Set(), dropped: new Set(), posted: [], reads: 0 }
  const unexpected = []
  const context = await browser.newContext({ hasTouch: width < 768, viewport: { width, height: 900 } })
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    const respond = (data, status = 200) => route.fulfill({ status, json: { data } })
    if (path === '/api/executors') return respond([executor])
    if (path === `/api/executors/${executorId}/access`) return respond(accessView)
    if (path === `/api/executors/${executorId}/coding-sessions` && method === 'GET') {
      state.reads += 1
      return respond(ExecutorCodingSessionListResponseSchema.parse({
        canClose,
        sessions: reported.filter((session) => !state.dropped.has(session.sessionId)).map((session) => ({
          ...session, closing: state.closing.has(session.sessionId), ownerAgentName: names[session.sessionId] ?? null,
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
  owner.dropClosing()
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

  console.log(`Executor coding sessions flows passed; screenshots: ${output}`)
} finally { await browser.close(); await stopProcess(admin) }
