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

// The confirmation card an assistant posts in chat after preparing a change.
// It holds only the change's id; every press mints a fresh token, for the
// presser, and the card opens the same review dialog with it (F6). It stays
// open until the change is confirmed, so a review closed early is pressed again.
const reviewCardId = '55555555-5555-4555-8555-555555555555'
const cardMintedToken = (press) => `card-${press}-${'c'.repeat(36)}`
const reviewCard = (pressed) => ({
  action: pressed ? 'none' : 'respond',
  actions: [{ key: 'review', label: 'Review', style: 'primary', submits: true }],
  agentId: uuid(900),
  agentName: 'Agent Designer',
  blocks: [{
    markdown: 'Review opens exactly what changes. Nothing is applied until you confirm it there, '
      + 'with your password. This expires in 10 minutes.',
    type: 'text',
  }],
  browserLogin: null,
  cardId: reviewCardId,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  messageId: uuid(901),
  resolution: pressed ? {
    actionKey: 'review', actionLabel: 'Review', at: new Date().toISOString(), byName: 'Ondrej Rafaj',
    byUserId: uuid(902), secrets: {}, values: {},
  } : null,
  service: null,
  status: pressed ? 'resolved' : 'open',
  subtitle: 'Give an agent access to this executor',
  threadId: uuid(903),
  title: 'Confirm an executor change',
  waitingFor: pressed ? [] : ['Ondrej Rafaj'],
})

const fixtureApi = () => {
  const roster = Array.from({ length: 26 }, (_, index) => makeAgent(index + 1, `Agent ${String(index + 1).padStart(2, '0')}`))
  const candidates = Array.from({ length: 26 }, (_, index) => makeAgent(index + 101, `Candidate ${String(index + 1).padStart(2, '0')}`))
  candidates[2].name = 'Personal Assistant'
  const prepared = new Map()
  const requests = []
  let cardPresses = 0
  let cardResolved = false
  let failure = null
  let verification = 'password'
  let hiddenIdentity = null
  let verificationCodesSent = 0
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
    cardPresses: () => cardPresses,
    failNext: (endpoint) => { failure = endpoint },
    verification: (method) => { verification = method },
    hideIdentity: (agentId) => { hiddenIdentity = agentId },
    route: async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const body = ['POST', 'PUT'].includes(request.method()) ? request.postDataJSON() : null
      requests.push({ path: url.pathname, search: url.search, method: request.method(), body })
      const send = (data, status = 200) => route.fulfill({ json: data, status })
      if (failure === url.pathname) {
        failure = null
        return send({ error: { code: 'TEMPORARY', message: 'Please try again.' } }, 503)
      }
      if (url.pathname === `/api/agent-cards/${reviewCardId}`) return send({ data: reviewCard(cardResolved) })
      if (url.pathname === `/api/agent-cards/${reviewCardId}/respond`) {
        assert.deepEqual(body, { actionKey: 'review', secrets: {}, values: {} },
          'a review press carries no value and no secret — the card has no inputs')
        assert.equal(cardResolved, false, 'a resolved card is never pressed')
        cardPresses += 1
        // The server's side of the press: a pending change this person
        // prepared from chat, and a token minted for them at this moment —
        // replacing the last one, so only the newest confirms.
        const accessChangeId = uuid(2000)
        const confirmationToken = cardMintedToken(cardPresses)
        prepared.set(accessChangeId, {
          change: { kind: 'agent_executor_grant', agentId: uuid(102), state: 'allowed' },
          receipt: {
            accessChangeId, confirmationToken, executorId,
            expiresAt: new Date(Date.now() + 600_000).toISOString(), requiresFreshVerification: true,
          },
          verificationMethod: 'password',
        })
        // Pressed, not answered: the card stays open while the change waits.
        return send({ data: {
          cardId: reviewCardId,
          executorReview: { accessChangeId, confirmationToken },
          status: 'open',
        } })
      }
      if (url.pathname === `/api/executors/${executorId}/agents` && request.method() === 'PUT') {
        const source = body.state === 'allowed' ? candidates : roster
        const destination = body.state === 'allowed' ? roster : candidates
        const index = source.findIndex((agent) => agent.agentId === body.agentId)
        assert.ok(index >= 0)
        destination.push({ ...source.splice(index, 1)[0], assigned: body.state === 'allowed' })
        return send({ data: { updated: true } })
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
      const decision = /^\/api\/executor-access-changes\/([^/]+)(?:\/(confirm|reject|verification))?$/
        .exec(url.pathname)
      if (decision) {
        const entry = prepared.get(decision[1])
        assert.ok(entry, 'Review must refer to a prepared change')
        if (!decision[2]) return send({ data: {
          ...entry.receipt, change: entry.change, status: 'pending', verificationMethod: entry.verificationMethod,
        } })
        assert.equal(body.confirmationToken, entry.receipt.confirmationToken)
        if (decision[2] === 'verification') {
          verificationCodesSent += 1
          return send({ data: { challengeId: uuid(3000 + verificationCodesSent),
            expiresAt: new Date(Date.now() + 300_000).toISOString(), twoFactorRequired: true } })
        }
        if (decision[2] === 'confirm' && entry.verificationMethod === 'sso_code'
          && body.ssoVerification?.code !== '123456') {
          return send({ error: { code: 'EXECUTOR_VERIFICATION_FAILED',
            message: 'Verification failed or expired. Check the code, or send a new one.' } }, 401)
        }
        if (decision[2] === 'confirm') {
          if (entry.receipt.requiresFreshVerification) {
            if (entry.verificationMethod === 'sso_code') {
              assert.equal(body.currentPassword, undefined)
              assert.deepEqual(body.ssoVerification, {
                challengeId: uuid(3000 + verificationCodesSent), code: '123456', twoFactorCode: '654321',
              })
            } else {
              assert.equal(entry.verificationMethod, 'password')
              assert.equal(body.currentPassword, 'fixture-proof')
            }
          }
          const { agentId, state } = entry.change
          const source = state === 'allowed' ? candidates : roster
          const destination = state === 'allowed' ? roster : candidates
          const index = source.findIndex((agent) => agent.agentId === agentId)
          assert.ok(index >= 0)
          destination.push({ ...source.splice(index, 1)[0], assigned: state === 'allowed' })
          // Confirming closes the chat card that opened the review.
          if (decision[1] === uuid(2000)) cardResolved = true
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
    assert.equal(await page.getByRole('dialog').count(), 0, 'assignment has no review dialog')
    assert.equal(prepareRequests().length, 0, 'assignment creates no continuation')
    assert.equal(api.roster.length, 27)
    await search.fill('Candidate 01')
    await visible(table.getByText('Candidate 01', { exact: true }))
    await table.getByRole('button', { name: 'Remove Candidate 01', exact: true }).click()
    await visible(page.getByText('No agents match your search.', { exact: true }))
    assert.equal(api.roster.length, 26)
    assert.equal(await page.getByRole('dialog').count(), 0, 'removal is immediate')
    api.failNext(`/api/executors/${executorId}/agents`)
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await addDialog.getByRole('searchbox').fill('Personal Assistant')
    await addDialog.getByRole('button', { name: 'Add Personal Assistant', exact: true }).click()
    await visible(addDialog.getByText('Please try again.', { exact: true }))
    assert.equal(api.roster.length, 26)
    await addDialog.getByRole('button', { name: 'Add Personal Assistant', exact: true }).click()
    await absent(addDialog)
    assert.ok(api.roster.some((agent) => agent.agentId === uuid(103)))
    assert.equal(prepareRequests().length, 0)

    // F6: a change prepared in chat is confirmed from the card the assistant
    // posted. The card never held a token; its Review press is answered with
    // one minted for the presser, and the same review dialog confirms with it.
    const card = page.getByRole('region', { name: 'Chat confirmation card' }).getByTestId('agent-card')
    await card.scrollIntoViewIfNeeded()
    await visible(card.getByText('Confirm an executor change', { exact: true }))
    await visible(card.getByText('Give an agent access to this executor', { exact: true }))
    assert.match(await card.innerText(), /Nothing is applied until you confirm it there, with your password/)
    await page.screenshot({ path: resolve(screenshots, `review-card-${viewport.width}.png`), fullPage: true })
    const reviewButton = card.getByRole('button', { name: 'Review', exact: true })
    await reviewButton.click()
    await visible(review)
    await visible(review.getByText('Candidate 02 will be able to use this machine’s approved permissions.'))
    assert.equal(await review.getByText('The confirmation token is missing', { exact: false }).count(), 0)
    assert.equal(page.url().includes(cardMintedToken(1)), false, 'the minted token never enters the address')
    // Closed without confirming: the change is still pending, so the card is
    // still open and its Review button presses again, minting a new token.
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    await absent(review)
    await visible(reviewButton)
    await reviewButton.click()
    await visible(review)
    assert.equal(api.cardPresses(), 2)
    assert.equal(page.url().includes(cardMintedToken(2)), false, 'nor does the second')
    // The review has only just opened: wait out its fade, or the shot shows
    // the card through a half-opaque dialog.
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))))
    await page.screenshot({ path: resolve(screenshots, `review-card-dialog-${viewport.width}.png`), fullPage: true })
    await review.getByLabel('Confirm with current password').fill('fixture-proof')
    await review.getByRole('button', { name: 'Allow access', exact: true }).click()
    await absent(review)
    // The stub asserted the confirm carried the newest press's token; the grant landed.
    const confirmCall = api.requests.find((entry) => entry.path === `/api/executor-access-changes/${uuid(2000)}/confirm`)
    assert.equal(confirmCall?.body.confirmationToken, cardMintedToken(2))
    assert.ok(api.roster.some((agent) => agent.agentId === uuid(102)), 'confirming from chat grants the agent')
    await visible(card.getByText(/^Review by Ondrej Rafaj/))
    assert.equal(await card.getByRole('button', { name: 'Review', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.deepEqual(errors, [])
    console.log(`Executor agents ${viewport.width}px: pagination, search, direct add/remove, retry and the chat confirmation card passed`)
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
