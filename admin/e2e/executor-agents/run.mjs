import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

// The real roster, picker and shared review dialog talk to a deterministic API.
// Backend entitlement and atomicity have database coverage in the API suite.
const executorId = '33333333-3333-4333-8333-333333333333'
const uuid = (number) => `44444444-4444-4444-8444-${String(number).padStart(12, '0')}`
const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/executor-agents')
const makeAgent = (number, name) => ({
  agentId: uuid(number), name, visibility: number === 1 ? 'private' : 'team',
  assigned: number !== 2, allowedOperationKeys: number === 1 ? [] : ['file.read', 'command.run'],
})

const fixtureApi = () => {
  const roster = Array.from({ length: 26 }, (_, index) => makeAgent(index + 1, `Agent ${String(index + 1).padStart(2, '0')}`))
  const candidates = Array.from({ length: 26 }, (_, index) => makeAgent(index + 101, `Candidate ${String(index + 1).padStart(2, '0')}`))
  candidates[2].name = 'Personal Assistant'
  const prepared = new Map()
  const requests = []
  let failure = null
  let verification = 'password'
  let hiddenIdentity = null
  const paginate = (rows, url) => {
    const query = url.searchParams.get('q') ?? ''
    const matching = rows.filter((row) => row.name.toLowerCase().includes(query.toLowerCase()))
    const limit = Number(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')
    const start = cursor ? Number(cursor.slice('opaque:'.length)) : 0
    const end = start + limit
    return { data: matching.slice(start, end), meta: {
      total: matching.length, hasMore: end < matching.length,
      nextCursor: end < matching.length ? `opaque:${end}` : null,
      prevCursor: start > 0 ? `opaque:${Math.max(0, start - limit)}` : null,
    } }
  }
  return {
    roster, candidates, requests,
    failNext: (endpoint) => { failure = endpoint },
    verification: (method) => { verification = method },
    hideIdentity: (agentId) => { hiddenIdentity = agentId },
    route: async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const body = request.method() === 'POST' ? request.postDataJSON() : null
      requests.push({ path: url.pathname, search: url.search, method: request.method(), body })
      const send = (data, status = 200) => route.fulfill({ json: data, status })
      if (failure === url.pathname) {
        failure = null
        return send({ error: { code: 'TEMPORARY', message: 'Please try again.' } }, 503)
      }
      if (url.pathname === `/api/executors/${executorId}/agents`) return send(paginate(roster, url))
      if (url.pathname === `/api/executors/${executorId}/agent-candidates`) return send(paginate(candidates, url))
      if (url.pathname === '/api/agents') return send({ data: [...roster, ...candidates]
        .filter((agent) => agent.agentId !== hiddenIdentity)
        .filter((agent) => url.searchParams.get('scope') === 'all' || agent.agentId !== uuid(103))
        .map((agent) => ({
        id: agent.agentId, name: agent.name, role: 'Assistant', visibility: agent.visibility,
        agentKind: agent.agentId === uuid(103) ? 'personal_assistant' : 'shared',
        systemManaged: agent.agentId === uuid(103),
        status: 'idle', todosEnabled: false, channelIds: [],
        lastActivityAt: '2026-09-21T12:00:00.000Z', createdAt: '2026-09-21T12:00:00.000Z',
        updatedAt: '2026-09-21T12:00:00.000Z',
      })) })
      if (url.pathname === '/api/users') return send({ data: [] })
      if (url.pathname === `/api/executors/${executorId}/access`) return send({ data: {
        executorId, canManage: true,
        effectiveAccess: { organizationRole: 'owner', privateAssignment: 'admin', projectRole: null },
        descriptorRevisions: [{
          revision: 1, reviewStatus: 'active', localPolicyDigest: `sha256:${'a'.repeat(64)}`,
          operationKeys: ['file.read', 'command.run'], profiles: ['workspace_sandbox'],
          workspaceFolders: ['projects'], commandAllowlist: ['git'],
        }],
      } })
      if (url.pathname === '/api/executor-access-changes' && body) {
        const accessChangeId = uuid(1000 + prepared.size)
        const receipt = {
          accessChangeId, confirmationToken: 'a'.repeat(43), executorId,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          // Private removal changes the roster and therefore also needs proof.
          requiresFreshVerification: true,
        }
        prepared.set(accessChangeId, { receipt, change: body.change, verificationMethod: verification })
        return send({ data: receipt })
      }
      const decision = /^\/api\/executor-access-changes\/([^/]+)(?:\/(confirm|reject))?$/.exec(url.pathname)
      if (decision) {
        const entry = prepared.get(decision[1])
        assert.ok(entry, 'Review must refer to a prepared change')
        if (!decision[2]) return send({ data: {
          ...entry.receipt, change: entry.change, status: 'pending', verificationMethod: entry.verificationMethod,
        } })
        assert.equal(body.confirmationToken, entry.receipt.confirmationToken)
        if (decision[2] === 'confirm') {
          if (entry.receipt.requiresFreshVerification) {
            assert.equal(entry.verificationMethod, 'password')
            assert.equal(body.currentPassword, 'fixture-proof')
          }
          const { agentId, state } = entry.change
          const source = state === 'allowed' ? candidates : roster
          const destination = state === 'allowed' ? roster : candidates
          const index = source.findIndex((agent) => agent.agentId === agentId)
          assert.ok(index >= 0)
          destination.push({ ...source.splice(index, 1)[0], assigned: state === 'allowed' })
        }
        return send({ data: { executorId, authorizationRevision: 2 } })
      }
      throw new Error(`Unexpected fixture request: ${request.method()} ${url.pathname}`)
    },
  }
}

const visible = async (locator) => { await locator.waitFor({ state: 'visible' }) }
const absent = async (locator) => { await locator.waitFor({ state: 'hidden' }) }

const evaluate = async (browser, viewport) => {
  const api = fixtureApi()
  const context = await browser.newContext({ viewport })
  await context.route('**/api/**', api.route)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const errors = []
  const browserMessages = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserMessages.push(message.text()) })
  const table = page.getByRole('table', { name: 'Executor agents' })
  const search = page.getByRole('searchbox', { name: 'Search agents', exact: true })
  const review = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Cancel change' }) })
  const addDialog = page.getByRole('dialog').filter({ has: page.getByRole('searchbox', { name: 'Search agents to add' }) })
  const prepareRequests = () => api.requests.filter((entry) => entry.path === '/api/executor-access-changes')
  try {
    await page.goto(`${ADMIN_URL}/e2e/executor-agents/index.html`)
    await visible(table)
    await visible(page.getByText('Page 1 of 2', { exact: true }))
    assert.equal(await table.locator('tbody tr').count(), 25)
    const first = table.getByRole('row').filter({ hasText: 'Agent 01' })
    assert.match(await first.innerText(), /Private/)
    assert.match(await first.innerText(), /No capabilities allowed yet/)
    const second = table.getByRole('row').filter({ hasText: 'Agent 02' })
    assert.match(await second.innerText(), /Not assigned to this private machine/)
    assert.match(await second.innerText(), /Read files, Run permitted programs/)
    assert.doesNotMatch(await table.innerText(), /file\.read|command\.run|44444444|Ready/)
    assert.equal(await page.getByRole('button', { name: /Expand/ }).count(), 0)

    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await visible(table.getByText('Agent 26', { exact: true }))
    assert.ok(api.requests.some((entry) => entry.search.includes('cursor=opaque%3A25')))
    await search.fill('Agent 01')
    await visible(table.getByText('Agent 01', { exact: true }))
    await visible(page.getByText('Page 1 of 1', { exact: true }))
    assert.equal(await table.locator('tbody tr').count(), 1)
    assert.ok(api.requests.some((entry) => entry.search.includes('q=Agent+01') && !entry.search.includes('cursor=')))
    await search.fill('')
    await visible(page.getByText('Page 1 of 2', { exact: true }))
    await page.getByRole('combobox', { name: 'Items per page' }).selectOption('10')
    await visible(page.getByText('Page 1 of 3', { exact: true }))
    assert.equal(await table.evaluate((element) => {
      const viewport = element.closest('.admin-expandable-table__viewport')
      return viewport.scrollWidth <= viewport.clientWidth
    }), true, 'Row actions must be visible without horizontal scrolling')
    await page.screenshot({ path: resolve(screenshots, `roster-${viewport.width}.png`), fullPage: true })

    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 01', exact: true }))
    assert.equal(await addDialog.getByRole('searchbox').evaluate((element) => element === document.activeElement), true)
    await addDialog.getByRole('button', { name: 'Next page', exact: true }).click()
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 26', exact: true }))
    await addDialog.getByRole('searchbox').fill('Candidate 01')
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 01', exact: true }))
    await visible(addDialog.getByText('Page 1 of 1', { exact: true }))
    await page.screenshot({ path: resolve(screenshots, `add-${viewport.width}.png`), fullPage: true })
    await addDialog.getByRole('button', { name: 'Add Candidate 01', exact: true }).click()
    await absent(addDialog)
    await visible(review)
    await visible(review.getByText('Folders (1):', { exact: false }))
    assert.match(await review.innerText(), /projects/)
    assert.match(await review.innerText(), /Permitted programs \(1\): git/)
    assert.deepEqual(prepareRequests().at(-1).body, {
      executorId, change: { kind: 'agent_executor_access', agentId: uuid(101), state: 'allowed' },
    })
    assert.equal(api.roster.length, 26, 'Preparing must not change access')
    assert.equal(await page.getByRole('dialog').count(), 1, 'Picker must close before review opens')
    await review.getByRole('button', { name: 'Cancel change', exact: true }).click()
    await absent(review)
    assert.equal(api.roster.length, 26, 'Rejecting must not change access')
    assert.equal(new URL(page.url()).searchParams.has('executor-add-cursor'), false)

    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 01', exact: true }))
    await addDialog.getByRole('button', { name: 'Add Candidate 01', exact: true }).click()
    await visible(review)
    await review.getByLabel('Confirm with current password').fill('fixture-proof')
    await review.getByRole('button', { name: 'Allow access', exact: true }).click()
    await absent(review)
    await search.fill('Candidate 01')
    await visible(table.getByText('Candidate 01', { exact: true }))
    assert.equal(api.roster.length, 27, 'Confirming adds one agent')
    await table.getByRole('button', { name: 'Remove Candidate 01', exact: true }).click()
    await visible(review)
    assert.deepEqual(prepareRequests().at(-1).body.change, {
      kind: 'agent_executor_access', agentId: uuid(101), state: 'denied',
    })
    assert.equal(api.roster.length, 27, 'Preparing removal must not remove the agent')
    await review.getByRole('button', { name: 'Cancel change', exact: true }).click()
    await absent(review)
    await visible(table.getByText('Candidate 01', { exact: true }))
    await table.getByRole('button', { name: 'Remove Candidate 01', exact: true }).click()
    await visible(review)
    await review.getByLabel('Confirm with current password').fill('fixture-proof')
    await review.getByRole('button', { name: 'Remove access', exact: true }).click()
    await absent(review)
    await visible(page.getByText('No agents match your search.', { exact: true }))
    assert.equal(api.roster.length, 26)

    api.verification('unavailable')
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 02', exact: true }))
    await addDialog.getByRole('button', { name: 'Add Candidate 02', exact: true }).click()
    await visible(review)
    await visible(review.getByText('Your sign-in provider does not yet support the extra identity check needed for this change.'))
    assert.equal(await review.locator('input[type=password]').count(), 0)
    assert.equal(await review.getByRole('button', { name: 'Allow access' }).isDisabled(), true)
    assert.doesNotMatch(await review.innerText(), /44444444|agent_executor_access|file\.read/)
    await page.screenshot({ path: resolve(screenshots, `identity-check-${viewport.width}.png`), fullPage: true })
    await review.getByRole('button', { name: 'Cancel change' }).click()
    await absent(review)
    assert.equal(api.roster.length, 26)

    await search.fill('Agent 03')
    await visible(table.getByText('Agent 03', { exact: true }))
    await table.getByRole('button', { name: 'Remove Agent 03', exact: true }).click()
    await visible(review)
    await visible(review.getByText('Your sign-in provider does not yet support the extra identity check needed for this change.'))
    assert.equal(await review.locator('input[type=password]').count(), 0)
    assert.equal(await review.getByRole('button', { name: 'Remove access' }).isDisabled(), true)
    await review.getByRole('button', { name: 'Cancel change' }).click()
    await absent(review)
    assert.equal(api.roster.length, 26)

    api.failNext(`/api/executors/${executorId}/agents`)
    await search.fill('Agent 04')
    await visible(page.getByText('Agents could not be loaded.', { exact: false }))
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await visible(table.getByText('Agent 04', { exact: true }))

    // The default agent list omits the system tier; the review must use the
    // entitled scope=all list shared with the candidate endpoint.
    api.verification('password')
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await addDialog.getByRole('searchbox').fill('Personal Assistant')
    await visible(addDialog.getByRole('button', { name: 'Add Personal Assistant', exact: true }))
    await addDialog.getByRole('button', { name: 'Add Personal Assistant', exact: true }).click()
    await visible(review)
    await visible(review.getByText('Personal Assistant will be able to use this machine’s approved permissions.'))
    assert.ok(api.requests.some((entry) => entry.path === '/api/agents' && entry.search === '?scope=all'))
    assert.equal(await review.getByRole('button', { name: 'Allow access' }).isEnabled(), true)
    await page.screenshot({ path: resolve(screenshots, `personal-assistant-review-${viewport.width}.png`) })
    await review.getByRole('button', { name: 'Cancel change' }).click()
    await absent(review)
    assert.equal(api.roster.length, 26)

    // Entitlement can disappear between candidate selection and review. A
    // cached picker label must not replace the review's live identity read.
    api.hideIdentity(uuid(104))
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await addDialog.getByRole('searchbox').fill('Candidate 04')
    await visible(addDialog.getByRole('button', { name: 'Add Candidate 04', exact: true }))
    await addDialog.getByRole('button', { name: 'Add Candidate 04', exact: true }).click()
    await visible(review)
    await visible(review.getByText('The selected agent could not be loaded. Close this change and try again.'))
    assert.equal(await review.getByRole('button', { name: 'Allow access' }).isDisabled(), true)
    assert.doesNotMatch(await review.innerText(), /44444444/)
    await review.getByRole('button', { name: 'Cancel change' }).click()
    await absent(review)
    assert.equal(api.roster.length, 26)
    assert.equal(api.requests.filter((entry) => entry.path === '/api/users').length, 0,
      'Agent changes must not query the people directory')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.deepEqual(errors, [])
    console.log(`Executor agents ${viewport.width}px: pagination, search, add, reject, confirm, remove and retry passed`)
  } catch (error) {
    await page.screenshot({ path: resolve(screenshots, `failure-${viewport.width}.png`), fullPage: true })
    console.error({ errors, browserMessages, body: (await page.locator('body').innerText()).slice(0, 3000) })
    throw error
  } finally {
    await context.close()
  }
}

let admin
let browser
try {
  await mkdir(screenshots, { recursive: true })
  await assertFreshServersAvailable()
  admin = await startAdmin({ reuseExisting: false })
  if (process.env.NAV_E2E_ADMIN_MODE !== 'preview') {
    assert.match(await (await fetch(ADMIN_URL)).text(), /@vite\/client/, 'Evaluation must serve live source')
  }
  browser = await launchBrowser()
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await evaluate(browser, viewport)
  }
} finally {
  await browser?.close()
  await stopProcess(admin)
}
