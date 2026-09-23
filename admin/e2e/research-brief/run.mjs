import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'
import { assertBrief, assertThreadCards, walkBriefToStart, walkNewBrief, walkReplyThreadBrief } from './steps.mjs'

/**
 * DeepWater research in the admin, rendered (Water plan nessie.md §7.7, §7.9;
 * amendments-fable F4, F8; amendments N8.5, N10).
 *
 * A pure fixture over a stubbed ApiClient — the real brief dialog, research
 * card, notice actions, Knowledge › Research and `/apps/deep-water` hero, no
 * database. The runner plays the server: the planner answering, a launch
 * landing, a revision conflict. It walks the person's whole brief (a one-tap
 * answer carrying an unsent pillar and setting edit, the planner's answer, a
 * conflict rebased with "what changed", Start with the publish switch), a new
 * brief from the composer, an agent's read-only brief, the failed and sign-in
 * states, every artifact action including the clipboard fallback, the
 * not-ready doorways for a member and an owner, and the owner's cancel of the
 * research that blocks turning DeepWater off. Every state is screenshotted
 * under e2e/screenshots/research-brief/.
 */

const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/research-brief')
const shot = (name) => resolve(SHOTS, name)

const ORG = '10000000-0000-4000-8000-000000000001'
const TEAM = '10000000-0000-4000-8000-000000000002'
const ME = '20000000-0000-4000-8000-000000000001'
const RUN_DONE = '50000000-0000-4000-8000-000000000003'
const RUN_SUMMARY = '50000000-0000-4000-8000-000000000004'
const RUNS = '/api/integrations/products/deep-water/research-runs'

const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local' },
  context: { bootstrapMode: false, channelId: null, organizationId: ORG, projectId: null, teamId: TEAM },
  session: { issuedAt: '2026-09-23T09:00:00.000Z', sessionId: '90000000-0000-4000-8000-000000000001' },
  user: { displayName: 'Ondřej Rafaj', email: 'ondrej@example.test', id: ME, roleIds: ['member'] },
}

const REPORT_BYTES = '# Heat pumps in Victorian terraced houses\n'
const SOURCES_BYTES = 'title,url,accessed_at\r\n"Field trial",https://example.org/trial,2026-09-23\r\n'

/** The session and the artifact bytes leave through fetch, not the ApiClient: answer them here. */
const routeServer = async (context) => {
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ body: JSON.stringify({ data: me }), contentType: 'application/json', status: 200 })
      return
    }
    const artifact = new RegExp(`^${RUNS}/([^/]+)/artifacts/(report\\.md|sources\\.csv)$`).exec(url.pathname)
    if (artifact && route.request().headers().authorization) {
      const report = artifact[2] === 'report.md'
      await route.fulfill({
        body: report ? REPORT_BYTES : SOURCES_BYTES,
        contentType: report ? 'text/markdown; charset=utf-8' : 'text/csv; charset=utf-8',
        status: 200,
      })
      return
    }
    await route.fulfill({ body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json', status: 404 })
  })
}

/** Every uncaught error on any page fails the run at the end, with the page it came from. */
const pageErrors = []

const open = async (context, query = '') => {
  const page = await context.newPage()
  page.on('pageerror', (error) => { pageErrors.push(`${query || '(thread)'}: ${error.message}`) })
  await page.goto(`${ADMIN_URL}/e2e/research-brief/index.html?${query}`)
  await page.locator('[data-ready="true"]').waitFor()
  return page
}

const settled = (page) => page.evaluate(() => new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 250)))
}))

/** A dialog is fixed to the viewport, so a shot with one open is of the viewport; a page shot is the whole page. */
const snap = async (page, name) => {
  await settled(page)
  const dialogOpen = (await page.getByRole('dialog').count()) > 0
  await page.screenshot({ fullPage: !dialogOpen, path: shot(name) })
}

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  await mkdir(SHOTS, { recursive: true })
  const desktop = await browser.newContext({
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { height: 1100, width: 1440 },
  })
  await routeServer(desktop)

  // 01 — the thread: every research card for this viewer, and the result reply's actions.
  const thread = await open(desktop)
  await assertThreadCards(thread)
  await snap(thread, '01-thread-cards.png')

  // Artifacts: the exact report and sources, under the research's own name.
  const done = thread.locator(`[data-card="${RUN_DONE}"]`)
  const [report] = await Promise.all([
    thread.waitForEvent('download'),
    done.getByRole('button', { name: 'Download report (.md)' }).click(),
  ])
  assert.equal(report.suggestedFilename(), 'heat-pumps-in-victorian-terraced-houses.md')
  const [sources] = await Promise.all([
    thread.waitForEvent('download'),
    done.getByRole('button', { name: 'Download sources (.csv)' }).click(),
  ])
  assert.equal(sources.suggestedFilename(), 'heat-pumps-in-victorian-terraced-houses.csv')
  const [summary] = await Promise.all([
    thread.waitForEvent('download'),
    thread.locator(`[data-card="${RUN_SUMMARY}"]`).getByRole('button', { name: 'Download summary (.md)' }).click(),
  ])
  assert.equal(summary.suggestedFilename(), 'grants-for-heat-pumps-in-the-uk-summary.md')
  await done.getByRole('button', { name: 'Copy markdown' }).click()
  await done.getByRole('button', { name: 'Copied' }).waitFor()
  const copied = await thread.evaluate(() => navigator.clipboard.readText())
  assert.match(copied, /^# Heat pumps in Victorian terraced houses/)

  // 02–06 — the person's own brief, from the card's doorway to a started research.
  await thread.locator('[data-card="50000000-0000-4000-8000-000000000001"]')
    .getByRole('button', { name: 'Continue the brief' }).click()
  const dialog = await assertBrief(thread)
  await snap(thread, '02-brief-drafting.png')
  await walkBriefToStart(thread, dialog, snap)
  await thread.close()

  // 07–08 — a new brief from the composer, pre-filled with what was typed.
  const composer = await open(desktop)
  await walkNewBrief(composer, snap)
  await composer.close()
  const reply = await open(desktop)
  await walkReplyThreadBrief(reply)
  await reply.close()

  // 09 — an agent's brief: read-only for its requester, who may only discard it.
  const agentPage = await open(desktop)
  await agentPage.locator('[data-card="50000000-0000-4000-8000-000000000002"]')
    .getByRole('button', { name: 'View brief' }).click()
  const agentDialog = agentPage.getByTestId('research-brief-dialog')
  await agentDialog.getByText('An agent is agreeing this brief with DeepWater.', { exact: false }).waitFor()
  assert.equal(await agentDialog.getByRole('button', { name: 'Start research' }).count(), 0)
  assert.equal(await agentDialog.getByRole('textbox').count(), 0, 'nobody types into an agent\'s brief')
  assert.equal(await agentDialog.getByRole('switch').count(), 0, 'an agent\'s research is never published')
  await agentDialog.getByText('An agent started this research, so it stays private', { exact: false }).waitFor()
  await agentDialog.getByRole('button', { name: 'Discard brief' }).waitFor()
  await snap(agentPage, '09-agent-brief.png')
  await agentPage.close()

  // 10 — a failed planner turn: Send again repeats the person's last words.
  const failed = await open(desktop, 'brief=failed&at=/channels/c?research=50000000-0000-4000-8000-000000000001')
  const failedDialog = failed.getByTestId('research-brief-dialog')
  await failedDialog.getByText('couldn’t answer just now', { exact: false }).waitFor()
  await failedDialog.getByRole('button', { name: 'Send again' }).click()
  const resend = await failed.evaluate(() => window.__research.calls.filter((call) => call.method === 'POST').at(-1))
  assert.equal(resend.body.message, 'How well do heat pumps work in Victorian terraced houses?')
  await snap(failed, '10-brief-failed-resent.png')
  await failed.close()

  // 11 — the sign-in the brief was opened with no longer works (F4).
  const signIn = await open(desktop, 'brief=sign-in&at=/channels/c?research=50000000-0000-4000-8000-000000000001')
  await signIn.getByTestId('research-brief-sign-in').getByText('Sign in again to continue this brief.').waitFor()
  await signIn.getByRole('button', { name: 'Sign in again' }).waitFor()
  await snap(signIn, '11-brief-sign-in.png')
  await signIn.close()

  // 12 — Copy markdown where the browser will not copy: the report, selected.
  const noClipboard = await browser.newContext({ viewport: { height: 1000, width: 1440 } })
  await routeServer(noClipboard)
  await noClipboard.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })
  const fallback = await open(noClipboard)
  await fallback.locator(`[data-card="${RUN_DONE}"]`).getByRole('button', { name: 'Copy markdown' }).click()
  const manual = fallback.getByTestId('research-manual-copy')
  await manual.waitFor()
  const selected = await fallback.evaluate(() => {
    const field = document.querySelector('[aria-label="Report markdown"]')
    return field ? field.value.slice(field.selectionStart, field.selectionEnd) : ''
  })
  assert.match(selected, /^# Heat pumps in Victorian terraced houses/)
  await snap(fallback, '12-copy-fallback.png')
  await noClipboard.close()

  // 13 — not ready, a member: the button is there and says why.
  const member = await open(desktop, 'readiness=team_off')
  const memberButton = member.locator(
    '[data-testid="composer-research-button"][title="Research with DeepWater — it’s off for this team"]',
  )
  await memberButton.waitFor()
  await memberButton.click()
  const memberReady = member.getByTestId('research-readiness')
  await memberReady.getByText('Ask a team owner to turn it on.', { exact: false }).waitFor()
  assert.equal(await memberReady.getByRole('link').count(), 0)
  await snap(member, '13-not-ready-member.png')
  await member.close()

  // 14 — not ready, an owner: the doorway to the DeepWater page, and turning it on there.
  const ownerPage = await open(desktop, 'readiness=team_off&owner=1')
  await ownerPage.getByTestId('composer-research-button').click()
  await ownerPage.getByTestId('research-readiness').getByRole('link', { name: 'Turn on DeepWater' }).click()
  const controls = ownerPage.getByTestId('deep-water-team-controls')
  await controls.getByText('DeepWater is off for this team.', { exact: false }).waitFor()
  await controls.getByRole('button', { name: 'Turn on DeepWater' }).click()
  await controls.getByRole('button', { name: 'Turn off DeepWater' }).waitFor()
  await snap(ownerPage, '14-owner-turned-on.png')
  await ownerPage.close()

  // 15–17 — turning it off is refused by an open research, which the owner cancels here.
  const hero = await open(desktop, 'owner=1&at=/apps/deep-water')
  const heroControls = hero.getByTestId('deep-water-team-controls')
  await heroControls.getByRole('button', { name: 'Turn off DeepWater' }).click()
  const confirm = hero.getByRole('dialog', { name: 'Turn off DeepWater for this team?' })
  await confirm.waitFor()
  await snap(hero, '15-hero-confirm-off.png')
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  const blocking = heroControls.getByTestId('deep-water-open-research')
  await blocking.getByText('A research started by an agent is being researched.', { exact: false }).waitFor()
  assert.doesNotMatch(await blocking.innerText(), /installers/i, 'the refusal never shows the research question')
  await snap(hero, '16-hero-open-research.png')
  await blocking.getByRole('button', { name: 'Cancel this research' }).click()
  await blocking.waitFor({ state: 'detached' })
  await heroControls.getByRole('button', { name: 'Turn off DeepWater' }).click()
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  await heroControls.getByRole('button', { name: 'Turn on DeepWater' }).waitFor()
  await snap(hero, '17-hero-turned-off.png')
  await hero.close()

  // 18 — Knowledge › Research: the viewer's research, and a new brief to their Personal Assistant.
  const knowledge = await open(desktop, 'at=/knowledge-base/views/deep-water-research')
  const list = knowledge.getByTestId('research-list')
  await list.getByText('Heat pumps in Victorian terraced houses', { exact: true }).waitFor()
  assert.equal(await list.locator('[data-research-run]').count(), 6)
  await list.getByText('Research summary (the full report could not be written).').waitFor()
  await snap(knowledge, '18-knowledge-research.png')
  await knowledge.getByRole('button', { name: 'New research' }).first().click()
  const personal = knowledge.getByTestId('research-brief-new')
  await personal.getByRole('textbox').first().fill('What does a heat pump cost to run in a flat?')
  await personal.getByRole('button', { name: 'Plan with DeepWater' }).click()
  await knowledge.getByTestId('research-brief-replying').waitFor()
  const created = await knowledge.evaluate((path) =>
    window.__research.calls.find((call) => call.method === 'POST' && call.path === path), RUNS)
  assert.deepEqual(created.body.origin, { kind: 'personal' })
  await knowledge.close()

  // 19 — the brief on a phone.
  const phone = await browser.newContext({ viewport: { height: 844, width: 390 } })
  await routeServer(phone)
  const phonePage = await open(phone, 'at=/channels/c?research=50000000-0000-4000-8000-000000000001')
  await phonePage.getByTestId('research-brief-workspace').waitFor()
  await snap(phonePage, '19-brief-phone.png')
  await phone.close()

  await desktop.close()
  assert.deepEqual(pageErrors, [], 'no page threw')
  console.log(`Research brief proofs passed: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
