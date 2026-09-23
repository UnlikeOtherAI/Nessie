#!/usr/bin/env node
// DeepWater research against the real stack: the real API with its embedded
// worker, the real admin, and a real database — ChannelsPage and its
// composer, the reply-thread panel, the Threads inbox card, Knowledge ›
// Research and the router, each reading the real brief API. The fixture suite
// (`run.mjs`) walks every state of the same components over a stubbed client;
// this one proves they are wired to the server they will meet.
//
// What it cannot do is open a brief from a composer. A brief needs the team to
// be `ready`, and `ready` needs a Ledger key and a UOA signer — with which
// every read also asks UOA, over the pinned egress that refuses a loopback
// double (docs/standards/egress.md). So the team here stops at the verdict a
// Nessie without Ledger honestly gives, `unavailable`, and Ledger's answers are
// played by `real-stack-ledger.mjs` through the watch's own projection and
// realtime announcer. The walk pins what that verdict must do on every
// doorway, and that an action the server refuses (a reply from a session with
// no UOA sign-in) says why rather than failing silently.
//
// It owns its servers and never adopts one already listening: run it on ports
// of its own beside a dev pair (`NAV_E2E_API_PORT` / `NAV_E2E_ADMIN_PORT`)
// with a migrated `DATABASE_URL`. Every screen is shot under
// e2e/screenshots/research-brief-real/.
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT, databaseUrl } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { call, seedTeam } from '../navigation/lib/seed.mjs'
import { openDeepWaterSeed } from './real-stack-ledger.mjs'

const SHOTS = resolve(REPO_ROOT, 'e2e', 'screenshots', 'research-brief-real')
const RUNS = '/api/integrations/products/deep-water/research-runs'
const OFF_TITLE = 'Research with DeepWater — it’s off for this team'
const UNAVAILABLE_TITLE = 'Research with DeepWater — it isn’t available right now'
const UNAVAILABLE_MESSAGE = 'DeepWater can’t be reached for this team right now. Try again in a little while.'

// A Nessie without Ledger: whatever the shell holds, the API this walk starts
// has no Ledger key, no Ledger address and no UOA signer, so nothing it runs
// can reach either service.
for (const name of [
  'LEDGER_PROXY_TOKEN', 'LEDGER_DEEPWATER_MCP_URL', 'LEDGER_PUBLIC_URL', 'UOA_BASE_URL', 'UOA_CLIENT_SECRET',
  'UOA_CONFIG_JWT_KID', 'UOA_CONFIG_JWT_PRIVATE_KEY_B64', 'UOA_CONFIG_URL', 'UOA_DOMAIN',
]) delete process.env[name]

const snap = (page, name) => page.screenshot({ fullPage: false, path: resolve(SHOTS, name) })

const researchParam = (page) => new URL(page.url()).searchParams.get('research')

/**
 * Press a composer's Research button and read the verdict it opens. The
 * composer's toolbar shows once a person is writing, so the composer the
 * button sits in is focused first, as a person's click into it does.
 */
const assertReadinessDoorway = async (page, button, { name, state, text }) => {
  await button.locator('xpath=ancestor::form[contains(@class, "admin-compose")][1]')
    .locator('.mention-editor').click()
  await button.waitFor({ state: 'visible' })
  assert.equal(await button.getAttribute('aria-label'), name, 'the button says why research cannot start yet')
  await button.click()
  const readiness = page.getByTestId('research-readiness')
  await readiness.waitFor()
  assert.equal(await readiness.getAttribute('data-state'), state)
  await readiness.getByText(text).waitFor()
  assert.equal(await page.getByTestId('research-brief-new').count(), 0, 'no form offers research the server refuses')
  return readiness
}

const closeDialog = async (page) => {
  await page.getByTestId('research-readiness').getByRole('button', { name: 'Close' }).click()
  await page.getByTestId('research-readiness').waitFor({ state: 'detached' })
}

/** DeepWater off: the composer's button says so, and the owner is sent to turn it on. */
const walkTeamOff = async (page, channel) => {
  await page.goto(`${ADMIN_URL}/channels/${channel.id}`, { waitUntil: 'domcontentloaded' })
  const button = page.getByTestId('composer-research-button')
  await button.waitFor({ state: 'attached', timeout: 60_000 })
  const readiness = await assertReadinessDoorway(page, button, {
    name: OFF_TITLE,
    state: 'team_off',
    text: 'DeepWater is off for this team. Turn it on to start research from any conversation.',
  })
  await snap(page, '01-composer-team-off.png')
  await readiness.getByRole('link', { name: 'Turn on DeepWater' }).click()
  await page.waitForURL(/\/apps\/deep-water/u)
  const controls = page.getByTestId('deep-water-team-controls')
  await controls.getByRole('button', { name: 'Turn on DeepWater' }).waitFor({ timeout: 30_000 })
  await snap(page, '02-hero-team-off.png')
}

/**
 * A launched research's card in its room, opened into the one brief dialog
 * through `?research=`, which a reload restores and Close clears.
 */
const walkResearchCard = async (page, channel, launched) => {
  await page.goto(`${ADMIN_URL}/channels/${channel.id}`, { waitUntil: 'domcontentloaded' })
  const card = page.getByTestId('research-card').filter({ hasText: launched.topic })
  await card.waitFor({ timeout: 60_000 })
  await card.getByText('Researching', { exact: true }).waitFor()
  await card.getByText('The result will come back to this conversation.', { exact: false }).waitFor()
  await snap(page, '03-research-card.png')

  await assertReadinessDoorway(page, page.getByTestId('composer-research-button'), {
    name: UNAVAILABLE_TITLE,
    state: 'unavailable',
    text: UNAVAILABLE_MESSAGE,
  })
  await snap(page, '04-composer-unavailable.png')
  await closeDialog(page)

  await card.getByTestId('research-brief-doorway').click()
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByText('DeepWater is researching.', { exact: false }).waitFor()
  assert.equal(researchParam(page), launched.runId, 'the open brief is in the address')
  await snap(page, '05-card-opens-brief.png')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await dialog.getByText('DeepWater is researching.', { exact: false }).waitFor({ timeout: 60_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(researchParam(page), null, 'closing the brief clears it from the address')
}

/**
 * The person's own brief, opened from its address: DeepWater's question and
 * pillars from the real brief API; an answer the server refuses says why; and
 * Ledger launching it reaches the open dialog and the room live.
 */
const walkOwnBrief = async (page, channel, brief, launch) => {
  await page.goto(`${ADMIN_URL}/channels/${channel.id}?research=${brief.runId}`, { waitUntil: 'domcontentloaded' })
  const dialog = page.getByTestId('research-brief-dialog')
  await dialog.getByTestId('research-brief-workspace').waitFor({ timeout: 60_000 })
  await dialog.getByTestId('research-brief-conversation')
    .getByText('Which part of the UK should it cover?', { exact: false }).waitFor()
  assert.equal(await dialog.getByTestId('research-brief-pillars').getByRole('textbox').count(), 2)
  await snap(page, '06-own-brief.png')

  const refused = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith(`${RUNS}/${brief.runId}/messages`))
  await dialog.getByTestId('research-brief-questions').getByRole('button', { name: 'England' }).click()
  // The reply is refused on the requester's own identity, which this session
  // (no UOA sign-in) does not carry, and the dialog names that remedy.
  const answer = await refused
  assert.equal(answer.status(), 409)
  const refusal = (await answer.json()).error
  assert.equal(refusal?.code, 'DEEP_WATER_NOT_READY')
  assert.deepEqual(refusal?.details, { reason: 'account_not_linked' })
  await dialog.getByText('Your sign-in isn’t linked to your organisation’s account for this team.', { exact: false })
    .first().waitFor()
  await snap(page, '07-own-brief-refused.png')

  await launch()
  await dialog.getByText('DeepWater is researching.', { exact: false }).waitFor({ timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByTestId('research-card').filter({ hasText: brief.topic }).waitFor({ timeout: 30_000 })
  await snap(page, '08-launch-arrives-live.png')
}

/**
 * A colleague's person drawer: its composer posts to the DM with them, and its
 * Research button says the same verdict.
 */
const walkPersonDrawer = async (page, channel, colleague) => {
  await page.goto(`${ADMIN_URL}/channels/${channel.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByText(colleague.greeting).waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: `Open ${colleague.displayName}` }).first().click()
  const drawer = page.getByRole('dialog', { name: `${colleague.displayName} info` })
  await drawer.waitFor()
  await assertReadinessDoorway(page, drawer.getByTestId('composer-research-button'), {
    name: UNAVAILABLE_TITLE,
    state: 'unavailable',
    text: UNAVAILABLE_MESSAGE,
  })
  await snap(page, '09-person-drawer-doorway.png')
  await closeDialog(page)
}

/** A reply thread's composer, and a Threads inbox card's, say the same verdict. */
const walkThreadDoorways = async (page, channel, launched, cardMessageId) => {
  await page.goto(
    `${ADMIN_URL}/channels/${channel.id}/threads/${channel.defaultThreadId}/replies/${cardMessageId}`,
    { waitUntil: 'domcontentloaded' },
  )
  const replies = page.getByTestId('thread-panel-replies')
  await replies.getByText('Can this cover battery storage too?').waitFor({ timeout: 60_000 })
  const panel = replies.locator('xpath=ancestor::*[.//*[@data-testid="composer-research-button"]][1]')
  await assertReadinessDoorway(page, panel.getByTestId('composer-research-button'), {
    name: UNAVAILABLE_TITLE,
    state: 'unavailable',
    text: UNAVAILABLE_MESSAGE,
  })
  await snap(page, '10-reply-thread-doorway.png')
  await closeDialog(page)

  await page.goto(`${ADMIN_URL}/threads`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Can this cover battery storage too?').first().waitFor({ timeout: 60_000 })
  await page.getByTestId('research-card').filter({ hasText: launched.topic }).first().waitFor()
  await assertReadinessDoorway(page, page.getByTestId('composer-research-button').first(), {
    name: UNAVAILABLE_TITLE,
    state: 'unavailable',
    text: UNAVAILABLE_MESSAGE,
  })
  await snap(page, '11-threads-inbox-doorway.png')
  await closeDialog(page)
}

/** Knowledge › Research lists both from the paginated brief API and opens one over itself. */
const walkKnowledgeResearch = async (page, runs) => {
  await page.goto(`${ADMIN_URL}/knowledge-base/views/deep-water-research`, { waitUntil: 'domcontentloaded' })
  const list = page.getByTestId('research-list')
  for (const run of runs) await list.locator(`[data-research-run="${run.runId}"]`).waitFor({ timeout: 60_000 })
  assert.equal(await list.locator('[data-research-run]').count(), runs.length)
  await snap(page, '12-knowledge-research.png')
  const row = list.locator(`[data-research-run="${runs[0].runId}"]`)
  await row.getByTestId('research-brief-doorway').click()
  await page.getByTestId('research-brief-dialog').getByText('DeepWater is researching.', { exact: false }).waitFor()
  assert.equal(researchParam(page), runs[0].runId)
  assert.match(page.url(), /\/knowledge-base\/views\/deep-water-research\?/u, 'the brief opens over Knowledge')
}

/** A member of the organisation, signed in through the password route, who speaks in the room. */
const signInColleague = async (ownerToken) => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const colleague = {
    displayName: `Research Colleague ${suffix}`,
    email: `research-colleague-${suffix}@example.com`,
    greeting: `Morning — I’ve shared the three solar quotes (${suffix}).`,
    password: `research-colleague-${suffix}-password`,
  }
  await call('/api/users', {
    body: { displayName: colleague.displayName, email: colleague.email, password: colleague.password, role: 'member' },
    method: 'POST',
    token: ownerToken,
  })
  const session = await call('/api/auth/session', {
    body: { email: colleague.email, password: colleague.password },
    method: 'POST',
  })
  return { ...colleague, token: session.token }
}

const main = async () => {
  if (!databaseUrl()) throw new Error('research-brief-real needs DATABASE_URL (a migrated database)')
  await rm(SHOTS, { force: true, recursive: true })
  await mkdir(SHOTS, { recursive: true })

  const api = await startApi({ reuseExisting: false })
  let admin
  let browser
  let context
  const ledger = openDeepWaterSeed()
  // What the walk wrote for DeepWater, removed afterwards. The colleague stays,
  // as every navigation fixture's people do: a person owns more than a row.
  const written = { connectorId: null, organizationId: null, runIds: [], teamId: null }
  try {
    admin = await startAdmin({ reuseExisting: false })
    const seed = await seedTeam(api)
    const me = await call('/api/auth/me', { token: seed.token })
    const channel = seed.channels[0]
    Object.assign(written, { organizationId: me.context.organizationId, teamId: seed.team.id })
    const ids = {
      channelId: channel.id,
      organizationId: me.context.organizationId,
      teamId: seed.team.id,
      threadId: channel.defaultThreadId,
      userId: me.user.id,
    }

    browser = await launchBrowser()
    context = await openViewportContext(browser, { name: 'desktop', token: seed.token })
    const { errors, page } = await context.newPage()

    await walkTeamOff(page, channel)

    written.connectorId = await ledger.enableTeam(ids)
    const own = await ledger.openBrief({ ...ids, connectorId: written.connectorId, topic: 'Heat pumps for the Leeds office' })
    const launched = await ledger.openBrief({ ...ids, connectorId: written.connectorId, topic: 'Solar panels on the warehouse roof' })
    written.runIds.push(own.runId, launched.runId)
    const cardMessageId = await ledger.launchBrief(ids.organizationId, launched)
    assert.ok(cardMessageId, 'the launched research has its card in the room')
    // A colleague says something in the room and replies under the card: the
    // Threads inbox lists a thread only for somebody else's reply.
    const colleague = await signInColleague(seed.token)
    for (const body of [
      { content: colleague.greeting },
      { content: 'Can this cover battery storage too?', rootMessageId: cardMessageId },
    ]) {
      await call(`/api/threads/${channel.defaultThreadId}/messages`, { body, method: 'POST', token: colleague.token })
    }

    await walkResearchCard(page, channel, launched)
    await walkOwnBrief(page, channel, own, () => ledger.launchBrief(ids.organizationId, own))
    await walkPersonDrawer(page, channel, colleague)
    await walkThreadDoorways(page, channel, launched, cardMessageId)
    await walkKnowledgeResearch(page, [own, launched])
    assert.deepEqual(errors, [], 'no page error on any screen')
    console.log('research-brief-real e2e: passed')
  } finally {
    if (context) await context.close()
    if (browser) await browser.close()
    await stopProcess(admin)
    await stopProcess(api)
    if (written.organizationId) await ledger.cleanup(written)
    await ledger.close()
  }
}

await main()
