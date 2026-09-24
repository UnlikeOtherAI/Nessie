import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The Triggers editor and the board's ticket-work doorways, rendered
 * (docs/plans/2026-09-23-ticket-driven-agents/verification.md). A pure fixture
 * over a stubbed ApiClient: the real `TriggerEditorDialog`,
 * `TriggerTypePicker`, `KanbanBoard` and `TriggerDetail`, no database.
 *
 * What it pins (docs/standards/ticket-work.md):
 * - the picker offers the five released types and, for an agent, "Ticket
 *   change"; `document_changed` is named nowhere, because it ships in T2;
 * - a ticket trigger's editor: public project channels only, and why; the
 *   board and its columns picked, not typed; a server refusal on the field it
 *   names (a second trigger on a column that already starts work); and the
 *   typed config a corrected create posts, with the quiet wake's minutes (T3);
 * - the board: "Moving here starts work: <agent>" on the start-work column,
 *   the agent's avatar and state dot on the cards it works, and the column
 *   menu's "Start work with an agent…", which opens the editor prefilled;
 * - a ticket trigger's page: its board and columns by name, and each delivery
 *   saying what was decided and why — a reminder and a quiet wake included —
 *   and its quiet wake.
 *
 * Every state is shot at 1280 and 390 px under e2e/screenshots/agent-triggers/.
 */

const SHOTS = resolve(REPO_ROOT, 'e2e/screenshots/agent-triggers')
const AGENT_ID = '60000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '60000000-0000-4000-8000-000000000002'
const BOARD = '60000000-0000-4000-8000-000000000012'
const BACKLOG = '60000000-0000-4000-8000-000000000013'
const DOING = '60000000-0000-4000-8000-000000000014'
const REVIEW = '60000000-0000-4000-8000-000000000015'
const DONE = '60000000-0000-4000-8000-000000000016'
const RELEASED = ['manual', 'scheduled', 'interval', 'webhook', 'event', 'ticket_changed']
const RELEASED_LABELS = ['Manual', 'Schedule', 'Interval', 'Webhook', 'Event', 'Ticket change']
const UNRELEASED = /document_changed|document change/i
const VIEWPORTS = [
  { name: 'desktop', options: { viewport: { height: 800, width: 1280 } } },
  { name: 'phone', options: { hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } } },
]

const settled = async (page) => {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  await page.waitForTimeout(150)
}

const openPage = async (browser, options, scenario) => {
  const context = await browser.newContext(options)
  // Nothing leaves for a real API: the session read is signed out, anything else is not in the fixture.
  await context.route('**/api/**', (route) => route.fulfill({
    body: '{"error":{"message":"not in fixture"}}', contentType: 'application/json',
    status: new URL(route.request().url()).pathname === '/api/auth/me' ? 401 : 404,
  }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${ADMIN_URL}/e2e/agent-triggers/index.html?scenario=${scenario}`)
  await page.locator('[data-ready="true"]').waitFor()
  return { context, errors, page }
}

const openDialog = async (browser, options, scenario) => {
  const opened = await openPage(browser, options, scenario)
  const dialog = opened.page.getByRole('dialog', { name: 'Create a trigger' })
  await dialog.waitFor()
  await settled(opened.page)
  return { ...opened, dialog }
}

const assertNoSidewaysScroll = async (page, label) => {
  const { inner, scroll } = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  assert.ok(scroll <= inner, `${label}: the page scrolls sideways (${scroll} > ${inner})`)
}

const assertOffersReleasedTypes = async (dialog, label) => {
  const picker = dialog.getByRole('group', { name: 'Trigger type' })
  await picker.waitFor()
  const radios = picker.locator('input[type="radio"]')
  assert.deepEqual(
    await radios.evaluateAll((nodes) => nodes.map((node) => node.value)),
    RELEASED,
    `${label}: an agent's picker offers the five released types and Ticket change, in order`,
  )
  for (const text of RELEASED_LABELS) {
    assert.ok(await picker.getByText(text, { exact: true }).isVisible(), `${label}: "${text}" is shown`)
  }
  // The markup, not just the painted text: a hidden option or an attribute
  // naming the unreleased type would be the half-exposure this suite exists to catch.
  assert.doesNotMatch(await dialog.evaluate((node) => node.outerHTML), UNRELEASED,
    `${label}: document_changed is named nowhere in the dialog`)
  assert.equal(await radios.nth(0).isChecked(), true, `${label}: a new trigger starts as manual`)
}

const posted = (page) => page.evaluate(() => window.__agentTriggersFixture.posted)

/** Pick Ticket change and check what its form offers before anything is typed. */
const openTicketForm = async (dialog, label) => {
  await dialog.getByText('Ticket change', { exact: true }).click()
  const channel = dialog.locator('#trigger-channel')
  assert.deepEqual(
    await channel.locator('option').evaluateAll((nodes) => nodes.map((node) => node.textContent)),
    ['engineering'],
    `${label}: only the public project channel is offered`,
  )
  await dialog.getByText(/Only public project channels are listed/).waitFor()
  const board = dialog.locator('#ticket-trigger-board')
  await board.locator('option', { hasText: 'Engineering' }).waitFor({ state: 'attached' })
  assert.equal(await board.inputValue(), BOARD, `${label}: the project's one board is chosen`)
  const inProgress = dialog.getByRole('checkbox', { name: 'In progress' }).first()
  await inProgress.waitFor()
  assert.equal(await inProgress.isChecked(), true, `${label}: a new trigger starts work from In progress`)
  const done = dialog.getByRole('checkbox', { exact: true, name: 'Done' })
  assert.equal(await done.isDisabled(), true, `${label}: an end column cannot also start work`)
  await dialog.getByText('Also wake on a connected board’s own changes').waitFor()
}

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  await mkdir(SHOTS, { recursive: true })

  for (const { name, options } of VIEWPORTS) {
    const width = options.viewport.width

    // 1. The picker, as every create opens.
    {
      const { context, dialog, errors, page } = await openDialog(browser, options, 'create')
      await assertOffersReleasedTypes(dialog, name)
      await assertNoSidewaysScroll(page, name)
      await page.screenshot({ path: resolve(SHOTS, `create-${width}.png`) })
      if (name === 'desktop') {
        // The picker still posts what was picked, through the create the Triggers page uses.
        await dialog.getByLabel('Trigger name').fill('Check the board')
        await dialog.getByText('Webhook', { exact: true }).click()
        assert.equal(await dialog.locator('input[type="radio"][value="webhook"]').isChecked(), true)
        await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        const [webhook] = await posted(page)
        assert.equal(webhook.path, `/api/agents/${AGENT_ID}/triggers`)
        assert.equal(webhook.body.type, 'webhook')
        assert.equal(webhook.body.name, 'Check the board')
        // A webhook may target the protected room; only ticket work is narrowed.
        assert.ok(webhook.body.targetChannelId, 'a channel is posted')
      }
      assert.deepEqual(errors, [], `${name}: no page errors`)
      await context.close()
    }

    // 2. A ticket trigger: its form, a refusal on the field it names, then the create.
    {
      const { context, dialog, errors, page } = await openDialog(browser, options, 'ticket')
      await openTicketForm(dialog, name)
      // The top of a ticket trigger's form: the channel rule said beside the
      // one channel it may use, then the board.
      await dialog.locator('#trigger-channel').scrollIntoViewIfNeeded()
      await settled(page)
      await page.screenshot({ path: resolve(SHOTS, `ticket-type-${width}.png`) })
      await dialog.getByLabel('Trigger name').fill('Start work from In progress')
      await dialog.getByRole('checkbox', { name: 'Review' }).first().check()
      await dialog.locator('#ticket-instructions-general').fill('Read the ticket and comment a plan on it.')
      await settled(page)
      await page.screenshot({ path: resolve(SHOTS, `ticket-form-${width}.png`) })

      // The quiet wake (T3): on at 30 minutes, off says what that costs, and
      // the minutes a person sets are what the create posts.
      const quiet = dialog.locator('fieldset', { has: page.locator('legend', { hasText: /^Quiet wake$/ }) })
      const minutes = quiet.locator('#ticket-trigger-quiet')
      assert.equal(await minutes.inputValue(), '30', `${name}: the quiet wake starts at its default`)
      await quiet.scrollIntoViewIfNeeded()
      await settled(page)
      await assertNoSidewaysScroll(page, `${name} quiet wake`)
      await quiet.screenshot({ path: resolve(SHOTS, `ticket-quiet-${width}.png`) })
      const toggle = quiet.getByRole('switch', { name: 'Wake the agent when its work has gone quiet' })
      await toggle.click()
      assert.equal(await minutes.count(), 0, `${name}: off hides the minutes`)
      await quiet.getByText('Off: work the agent forgets to check on waits until a person changes the ticket.').waitFor()
      await settled(page)
      await quiet.screenshot({ path: resolve(SHOTS, `ticket-quiet-off-${width}.png`) })
      await toggle.click()
      await minutes.fill('45')

      await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
      const refusal = dialog.locator('[data-field-error="pickup"]')
      await refusal.waitFor()
      assert.match(
        await refusal.innerText(),
        /column "Review" is already a start-work column of the enabled trigger "Review pass"/,
      )
      await dialog.getByText('Fix the fields marked below.').waitFor()
      assert.equal(await dialog.isVisible(), true, `${name}: a refusal keeps the dialog open`)
      await refusal.scrollIntoViewIfNeeded()
      await settled(page)
      await assertNoSidewaysScroll(page, `${name} refused`)
      await page.screenshot({ path: resolve(SHOTS, `ticket-refused-${width}.png`) })

      // Fixed where it was refused, and created as the typed config.
      await dialog.getByRole('checkbox', { name: 'Review' }).first().uncheck()
      await dialog.getByRole('button', { name: 'Create trigger', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      const creates = await posted(page)
      assert.equal(creates.length, 2, 'one refused create, one accepted')
      const body = creates[1].body
      assert.equal(body.type, 'ticket_changed')
      assert.equal(body.targetChannelId, CHANNEL_ID, 'the public channel, never the protected one')
      assert.equal(body.nextRunAt, undefined, 'a ticket trigger has no schedule')
      assert.deepEqual(body.config, {
        boardId: BOARD,
        endOn: [{ category: 'todo' }, { category: 'done' }],
        follow: {
          includeSourceEvents: false,
          kinds: ['comment', 'description', 'moved', 'thread_message', 'document'],
        },
        instructions: { general: 'Read the ticket and comment a plan on it.' },
        limits: { startsPerDay: 20, wakesPerTicket: 30 },
        pickup: { assignOnPickup: true, columns: [{ id: DOING }] },
        quietWakeMinutes: 45,
      })
      assert.deepEqual(errors, [], `${name}: no page errors`)
      await context.close()
    }

    // 3. The board: the badge, the dots, and the doorway that opens the editor prefilled.
    {
      const { context, errors, page } = await openPage(browser, options, 'board')
      const review = page.locator(`[data-kanban-column="${REVIEW}"]`)
      const badge = review.getByTestId('column-starts-work')
      await badge.waitFor()
      assert.equal((await badge.innerText()).trim(), 'Moving here starts work: Reviewer')
      assert.equal(
        await page.getByTestId('column-starts-work').count(), 1,
        'only the column a trigger starts work from carries the badge',
      )
      const dots = page.getByTestId('ticket-work-card-dot')
      assert.deepEqual(
        await dots.evaluateAll((nodes) => nodes.map((node) => [node.dataset.workStatus, node.getAttribute('aria-label')])),
        [['active', 'CTO · working'], ['failed', 'CTO · stopped — its wakes are used up']],
      )
      // The badge sits at the head of its column's track, so every track still
      // starts on one line.
      if (name !== 'phone') {
        const trackTops = await page.locator('[data-kanban-dropzone]').evaluateAll((nodes) =>
          nodes.map((node) => Math.round(node.getBoundingClientRect().top)))
        assert.equal(new Set(trackTops).size, 1, `every track starts on one line (${trackTops.join(', ')})`)
      }
      // "Start work with an agent…" on every column but Done, whose menu archives.
      assert.equal(await page.locator(`[data-kanban-column="${BACKLOG}"]`).getByTestId('column-work-menu').count(), 1)
      assert.equal(await page.locator(`[data-kanban-column="${DONE}"]`).getByTestId('column-work-menu').count(), 0)
      await settled(page)
      await page.screenshot({ path: resolve(SHOTS, `board-${width}.png`) })
      if (name === 'phone') {
        // One column a page on a phone: page to the cards the agent works, then
        // to the column that starts the Reviewer's work.
        for (const [pageNumber, shotName] of [[3, 'board-badge-390.png'], [2, 'board-dots-390.png']]) {
          await page.getByRole('button', { name: `Show page ${pageNumber}` }).click()
          await page.waitForFunction((column) => {
            const box = document.querySelector(`[data-kanban-column="${column}"]`)?.getBoundingClientRect()
            return Boolean(box && box.left >= 0 && box.right <= window.innerWidth + 1)
          }, pageNumber === 3 ? REVIEW : DOING)
          await settled(page)
          await page.screenshot({ path: resolve(SHOTS, shotName) })
        }
      }

      const doing = page.locator(`[data-kanban-column="${DOING}"]`)
      await doing.getByTestId('column-work-menu').click()
      await page.getByRole('menuitem', { name: 'Start work with an agent…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create a trigger' })
      await dialog.waitFor()
      await settled(page)
      // Opened on a ticket trigger for this column: its type and target kind are fixed.
      assert.equal(await dialog.locator('input[type="radio"]').count(), 0, 'no type picker from the board')
      // (The field labels are set in capitals.)
      assert.match(await dialog.innerText(), /Trigger type\s+Ticket change/i)
      assert.match(await dialog.innerText(), /Target kind\s+Agent/i)
      assert.equal(await dialog.locator('#trigger-target-kind').count(), 0)
      assert.equal(await dialog.getByLabel('Trigger name').inputValue(), 'Start work from In progress')
      assert.equal(await dialog.locator('#ticket-trigger-board').inputValue(), BOARD)
      assert.equal(await dialog.getByRole('checkbox', { name: 'In progress' }).first().isChecked(), true)
      assert.equal(await dialog.getByRole('checkbox', { name: 'Review' }).first().isChecked(), false)
      await assertNoSidewaysScroll(page, `${name} doorway`)
      await page.screenshot({ path: resolve(SHOTS, `board-start-work-${width}.png`) })
      assert.deepEqual(errors, [], `${name}: no page errors`)
      await context.close()
    }

    // 4. A ticket trigger's own page: named facts, and deliveries that say why.
    {
      const { context, errors, page } = await openPage(browser, options, 'detail')
      await page.getByText('When a person moves a ticket into In progress', { exact: false }).waitFor()
      const lines = page.getByTestId('ticket-delivery-line')
      await lines.first().waitFor()
      await page.getByText('After 30 minutes with nothing scheduled', { exact: false }).waitFor()
      assert.deepEqual(await lines.allInnerTexts(), [
        'Woke the agent: nothing else was scheduled.',
        'Woke the agent: a reminder.',
        'Woke the agent: a comment.',
        'Moved by an agent, so work did not start. A person who can edit the board can start it.',
        'Started work on the ticket.',
      ])
      await assertNoSidewaysScroll(page, `${name} detail`)
      await settled(page)
      await page.screenshot({ fullPage: true, path: resolve(SHOTS, `detail-${width}.png`) })
      assert.deepEqual(errors, [], `${name}: no page errors`)
      await context.close()
    }
  }

  console.log(`Agent triggers proofs passed; screenshots: ${SHOTS}`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
