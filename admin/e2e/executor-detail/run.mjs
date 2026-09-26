import assert from 'node:assert/strict'
import { ExecutorAccessViewResponseSchema, ExecutorStandingPolicyListResponseSchema } from '@nessie/schemas'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { assertFreshServersAvailable, startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

const executorId = '33333333-3333-4333-8333-333333333333'
const userId = '11111111-1111-4111-8111-111111111111'
const changeId = '44444444-4444-4444-8444-444444444444'
const teamId = '77777777-7777-4777-8777-777777777777'
const invitedId = '88888888-8888-4888-8888-888888888888'
const projectId = '99999999-9999-4999-8999-999999999999'
const timestamp = '2026-09-21T00:00:00.000Z'
const executor = { id: executorId, label: 'Studio Mac', profiles: ['workspace_sandbox'], status: 'offline',
  scope: { kind: 'private', organizationId: '22222222-2222-4222-8222-222222222222' },
  authorizationRevision: 1, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp }
const revision = { revision: 12, profiles: ['workspace_sandbox'], operationKeys: ['file.read', 'command.run'],
  commandAllowlist: ['git', 'node'], workspaceFolders: ['projects'], reviewStatus: 'pending_review', localPolicyDigest: `sha256:${'a'.repeat(64)}` }
const access = { executorId, canManage: true, effectiveAccess: { privateAssignment: 'admin', projectRole: null, organizationRole: 'owner' },
  privateAssignments: [{ principalKind: 'user', userId, role: 'admin' }], operationGrants: [],
  descriptorRevisions: [revision, { ...revision, revision: 11, workspaceFolders: ['old-folder'] }],
  sessions: [{ id: changeId, createdAt: timestamp, updatedAt: timestamp, profile: 'coding_session', status: 'stopped', originChannelId: userId }] }

// The Standing access panel: one trigger live with a ticket working here, one
// suspended by a trigger edit, and one whose card is still waiting for its author.
const policyId = (n) => `55555555-5555-4555-8555-55555555555${n}`
const triggerId = (n) => `66666666-6666-4666-8666-66666666666${n}`
const standingRow = (n, fields) => ({
  id: policyId(n), suspendedReason: null, trigger: null, agentName: null, authorName: 'Alex',
  confirmedAt: timestamp, createdAt: timestamp, activeTickets: 0, viewerCanEnd: true, ...fields,
})
// T5: the ticket holding the machine under the live policy, named for a reader who can open it.
const holdingTicket = {
  projectId: '77777777-7777-4777-8777-777777777771', status: 'active',
  taskId: '77777777-7777-4777-8777-777777777772', title: 'NES-140 Fix login redirect',
}
const standing = ExecutorStandingPolicyListResponseSchema.parse({ policies: [
  standingRow(1, { status: 'live', trigger: { id: triggerId(1), name: 'Pick up tickets' }, agentName: 'CTO',
    authorName: 'Ondrej', activeTickets: 1, holdingTicket }),
  standingRow(2, { status: 'suspended', suspendedReason: 'trigger_changed',
    trigger: { id: triggerId(2), name: 'Fix reported bugs' }, agentName: 'Bug fixer' }),
  standingRow(3, { status: 'preparing', trigger: { id: triggerId(3), name: 'Write release notes' },
    agentName: 'Writer', confirmedAt: null }),
] }).policies
const output = resolve(REPO_ROOT, 'e2e/screenshots/executor-detail')
ExecutorAccessViewResponseSchema.parse(access)

/**
 * One browser context whose API is this closure. `policies` is the machine's
 * Standing access answer; End removes its row from the next read, the way
 * the list leaves out what has ended.
 */
const openContext = async (browser, width, { policies = standing } = {}) => {
  const permissions = { executorId, teamId, ownerUserId: userId, everyone: false,
    people: [{ userId, name: 'Alex', role: 'admin' }], projects: [],
    availablePeople: [{ userId: invitedId, name: 'Sam' }],
    availableProjects: [{ projectId, name: 'Website' }] }
  const state = { sharing: [], ended: [], policies: [...policies], prepared: null, unexpected: [] }
  const context = await browser.newContext({ hasTouch: width === 390, viewport: { width, height: 900 } })
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    const respond = (data) => route.fulfill({ json: { data } })
    if (path === '/api/executors') return respond([{
      ...executor, sharedWithTeam: permissions.everyone || permissions.projects.length > 0,
    }])
    if (path.endsWith('/sharing')) {
      if (method === 'PUT') {
        const { change } = route.request().postDataJSON()
        state.sharing.push(change)
        if (change.kind === 'team') permissions.everyone = change.enabled
        if (change.kind === 'person') {
          permissions.people = permissions.people.filter((entry) => entry.userId !== change.userId)
          if (change.role) permissions.people.push({ userId: change.userId, name: 'Sam', role: change.role })
        }
        if (change.kind === 'project') permissions.projects = change.enabled ? [{ projectId, name: 'Website' }] : []
        return respond({ updated: true })
      }
      return respond(permissions)
    }
    if (path.endsWith('/access')) return respond(access)
    if (path === `/api/executors/${executorId}/agents`) return route.fulfill({ json: { data: [], meta: { total: 0, hasMore: false, prevCursor: null, nextCursor: null } } })
    if (path === `/api/executors/${executorId}/leases`) return respond([])
    if (path === `/api/executors/${executorId}/standing-policies` && method === 'GET') {
      return respond({ policies: state.policies })
    }
    const ending = path.match(/^\/api\/standing-policies\/([^/]+)\/end$/)
    if (ending && method === 'POST') {
      state.ended.push(ending[1])
      state.policies = state.policies.filter((policy) => policy.id !== ending[1])
      return respond({ ended: true })
    }
    if (path === '/api/users') return respond([{ id: userId, displayName: 'Alex' }])
    if (path === '/api/agents') return respond([])
    if (path === '/api/local-inference/hosts') return respond({ hosts: [{
      id: userId, executorId, availability: 'offline', status: 'active', paused: false,
      transport: 'executor', models: [], lastSeenAt: timestamp,
    }], meta: { total: 1 } })
    if (path === '/api/executor-access-changes') {
      state.prepared = route.request().postDataJSON().change
      return respond({ accessChangeId: changeId, executorId, confirmationToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString(), requiresFreshVerification: true })
    }
    if (path === `/api/executor-access-changes/${changeId}`) return respond({
      accessChangeId: changeId, executorId, change: state.prepared, status: 'pending',
      expiresAt: new Date(Date.now() + 600000).toISOString(), requiresFreshVerification: true, verificationMethod: 'unavailable',
    })
    state.unexpected.push(`${method} ${path}`)
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, errors, page, state }
}

const standingRowOf = (section, name) => section.getByRole('row').filter({ hasText: name })

await assertFreshServersAvailable()
const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const served = await fetch(ADMIN_URL).then((r) => r.text())
  if (process.env.NAV_E2E_ADMIN_MODE !== 'preview') assert.ok(served.includes('@vite/client'))
  await mkdir(output, { recursive: true })
  for (const width of [1280, 390]) {
    const { context, errors, page, state } = await openContext(browser, width)
    const { unexpected } = state
    await page.goto(`${ADMIN_URL}/e2e/executor-detail/index.html`)
    await page.getByRole('heading', { name: 'Studio Mac' }).waitFor()
    try { await page.getByRole('button', { name: 'Add agent', exact: true }).waitFor() }
    catch (error) { console.error(await page.locator('body').innerText(), errors, unexpected); throw error }
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.getByText('Your effective access:', { exact: false }).count(), 0)
    assert.equal(await page.getByText('Local Ollama', { exact: true }).count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `agents-${width}.png`) })
    await page.getByRole('tab', { name: /^Permissions/ }).click()
    await page.getByLabel('Everyone in this team can use this executor').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Review changes', exact: true }).count(), 0)
    await page.getByLabel('Person', { exact: true }).selectOption(invitedId)
    await page.getByLabel('Access', { exact: true }).selectOption('admin')
    await page.getByRole('button', { name: 'Add person', exact: true }).click()
    await page.getByLabel('Access for Sam').waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.getByLabel('Project', { exact: true }).selectOption(projectId)
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    await page.getByRole('region', { name: 'Projects with access' }).getByText('Website', { exact: true }).waitFor()
    await page.getByLabel('Everyone in this team can use this executor').click()
    await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
    assert.deepEqual(state.sharing, [
      { kind: 'person', userId: invitedId, role: 'admin' },
      { kind: 'project', projectId, enabled: true }, { kind: 'team', enabled: true },
    ])
    await page.screenshot({ animations: 'disabled', path: resolve(output, `permissions-${width}.png`) })
    await page.getByRole('tab', { name: 'Activity', exact: true }).click()
    const conversation = page.getByRole('link', { name: 'Open conversation' })
    await conversation.waitFor()
    const bounds = await conversation.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Conversation stays visible on phone')
    assert.equal(await page.getByRole('button', { name: /revocation/i }).count(), 0)
    await page.screenshot({ animations: 'disabled', path: resolve(output, `activity-${width}.png`) })

    // Standing access: each trigger whose work runs here, who set it up, its state and End.
    const standingSection = page.getByRole('region', { name: 'Standing access' })
    await standingSection.getByRole('heading', { name: 'Standing access' }).waitFor()
    await standingSection.getByText('Ticket triggers whose work runs on this machine as its owner, confirmed once.').waitFor()
    const live = standingRowOf(standingSection, 'Pick up tickets')
    await live.waitFor()
    assert.match(await live.innerText(),
      new RegExp('Pick up tickets[\\s\\S]*set up by Ondrej[\\s\\S]*CTO[\\s\\S]*Live[\\s\\S]*'
        + 'NES-140 Fix login redirect[\\s\\S]*holds this machine, working'))
    assert.equal(await standingSection.getByRole('link', { name: 'Pick up tickets' }).getAttribute('href'),
      `/admin/automations/triggers/${triggerId(1)}`, 'the trigger links to its own screen')
    // Which ticket holds the machine (T5), linked to the ticket on its board.
    assert.equal(
      await standingSection.getByRole('link', { name: 'NES-140 Fix login redirect' }).first().getAttribute('href'),
      `/projects/${holdingTicket.projectId}/board?task=${holdingTicket.taskId}`,
    )
    assert.match(await standingRowOf(standingSection, 'Fix reported bugs').innerText(),
      /set up by Alex[\s\S]*Suspended[\s\S]*The trigger was edited, so it waits until Alex confirms again\./)
    assert.match(await standingRowOf(standingSection, 'Write release notes').innerText(),
      /Awaiting confirmation[\s\S]*Nothing runs here until Alex confirms it\.[\s\S]*No tickets working here/)
    assert.equal(await standingSection.getByRole('button', { name: /^End standing access for / }).count(), 3)
    const endLive = standingSection.getByRole('button', { name: 'End standing access for Pick up tickets' })
    await standingSection.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: resolve(output, `standing-access-${width}.png`) })
    const endBounds = await endLive.boundingBox()
    assert.ok(endBounds && endBounds.x >= 0 && endBounds.x + endBounds.width <= width, `End stays on screen: ${JSON.stringify(endBounds)}`)

    await endLive.click()
    const confirm = page.getByRole('dialog', { name: 'End standing access for “Pick up tickets”?' })
    await confirm.waitFor()
    const confirmText = await confirm.innerText()
    assert.match(confirmText, /Ending it cancels this trigger’s tickets that are working or waiting, and closes/)
    assert.match(confirmText, /their coding sessions on its machines\./)
    assert.match(confirmText, /Ondrej has to set it up again before any of its tickets runs on a machine\./)
    assert.deepEqual(state.ended, [], 'opening the confirmation ends nothing')
    await page.screenshot({ animations: 'disabled', path: resolve(output, `standing-access-end-${width}.png`) })
    await confirm.getByRole('button', { name: 'End standing access', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    assert.deepEqual(state.ended, [policyId(1)], 'End posts that policy’s end, and only that one')
    await live.waitFor({ state: 'detached' })
    assert.equal(await standingSection.getByRole('button', { name: /^End standing access for / }).count(), 2)
    await standingSection.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: resolve(output, `standing-access-ended-${width}.png`) })

    await page.getByRole('button', { name: 'Machine', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Local models' }).click()
    const models = page.getByRole('dialog', { name: 'Local models', exact: true })
    await models.getByRole('button', { name: 'Disconnect local models' }).click()
    await page.getByRole('dialog', { name: 'Disconnect local models?' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await models.isVisible(), true, 'Nested confirmation closes before its owning modal')
    await page.keyboard.press('Escape')
    await page.goto(`${ADMIN_URL}/e2e/executor-detail/index.html?project=1`)
    await page.getByRole('row').filter({ hasText: 'Studio Mac' }).waitFor()
    await page.screenshot({ animations: 'disabled', path: resolve(output, `project-${width}.png`) })
    await page.getByRole('row').filter({ hasText: 'Studio Mac' }).click()
    await page.getByRole('heading', { name: 'Studio Mac' }).waitFor()
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
    await context.close()
  }

  // A private machine no trigger's work runs on says so, in the same place.
  for (const width of [1280, 390]) {
    const { context, errors, page, state } = await openContext(browser, width, { policies: [] })
    await page.goto(`${ADMIN_URL}/e2e/executor-detail/index.html`)
    await page.getByRole('heading', { name: 'Studio Mac' }).waitFor()
    await page.getByRole('tab', { name: 'Activity', exact: true }).click()
    const standingSection = page.getByRole('region', { name: 'Standing access' })
    const empty = standingSection.getByText('No trigger’s work runs on this machine.')
    await empty.waitFor()
    assert.equal(await standingSection.getByRole('button', { name: /^End / }).count(), 0)
    await standingSection.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: resolve(output, `standing-access-empty-${width}.png`) })
    assert.deepEqual(errors, [])
    assert.deepEqual(state.unexpected, [])
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page overflow')
    await context.close()
  }
  console.log(`Executor detail flows passed; screenshots: ${output}`)
} finally { await browser.close(); await stopProcess(admin) }
