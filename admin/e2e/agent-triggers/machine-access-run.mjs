import assert from 'node:assert/strict'

import { assertNoSidewaysScroll, openPage, posted, settled, shot } from './helpers.mjs'

/**
 * A ticket trigger's Machine access section, rendered (docs/standards/
 * ticket-work-machine-access.md → "What the screens show"), over the stubs in
 * `machine-access.tsx`:
 *
 * - every state — not set up (for the author, and read-only for an owner who
 *   is not), awaiting confirmation, live (machines named to the author and to
 *   nobody else), suspended with its reason, ended by whom — with its tickets
 *   and their places, and the last wakes in words;
 * - the author's setup form: a machine refused whatever is chosen, one refused
 *   until the "run any command" tick, one whose per-turn budget is over the
 *   ticket limit, the shared coding folders, and the exact prepare it posts;
 * - a prepare the server refuses for a machine, then the one card in the
 *   section, and its Review opening the real access-change dialog with the
 *   password field;
 * - End, confirmed, posting the policy's end.
 */

const MINIS = '60000000-0000-4000-8000-000000000610'
const STATES = [
  ['not_set_up', /^Tickets this trigger picks up wait for machine access\./],
  ['not_set_up_other', /^Tickets this trigger picks up wait for machine access\./],
  ['awaiting', /^Ondrej has a card to confirm with their password\./],
  ['live', /: anyone who can edit the board starts work on Minis and Studio, as Ondrej\.$/],
  ['live_other', /: anyone who can edit the board starts work on two machines of Ondrej’s, as Ondrej\.$/],
  ['suspended', /^Paused because the trigger was edited .* Tickets wait until Ondrej confirms it again\.$/],
  ['ended', /by Ondrej: it was ended by hand\. Tickets wait for machine access until Ondrej sets it up again\.$/],
]

const openSection = async (browser, options, access) => {
  const opened = await openPage(browser, options, `detail&access=${access}`)
  const section = opened.page.getByTestId('machine-access-section')
  await section.getByTestId('machine-access-state').waitFor()
  await settled(opened.page)
  return { ...opened, section }
}

const states = async (browser, { name, options }) => {
  const width = options.viewport.width
  for (const [access, sentence] of STATES) {
    const { context, errors, page, section } = await openSection(browser, options, access)
    assert.match(await section.getByTestId('machine-access-state').innerText(), sentence, `${name} ${access}`)
    const text = await section.innerText()
    // T5: a ticket whose machine went away says since when, and its place is kept.
    const pausedSince =
      /NES-141 Refactor billing\s+paused: (Studio|its machine) is offline since \d{1,2}:\d{2}(\s?[AP]M)?/
    if (access === 'live') {
      assert.match(text, /NES-140 Fix login redirect\s+working on Minis/)
      assert.match(text, pausedSince)
      assert.match(text, /paused: Studio is offline since/)
      assert.match(text, /NES-143 Speed up search\s+queued: position 1, every machine is busy/)
      assert.match(text, /NES-144 Tidy settings\s+queued: position 2, every machine is busy/)
      assert.match(text, /Limits: 4 hours and \$20 a ticket, \$60 a day\./)
      assert.match(text, /it gets no other program on them/)
      assert.equal(await section.getByRole('button', { name: 'End' }).count(), 1, 'the author may end it')
    }
    if (access === 'live_other') {
      assert.doesNotMatch(text, /Minis|Studio/, 'an owner who does not administer the machines is not told them')
      assert.match(text, /NES-140 Fix login redirect\s+working/)
      assert.match(text, /paused: its machine is offline since/)
      assert.equal(await section.getByRole('button', { name: /End|Set up|Change/ }).count(), 0, `${name}: read-only`)
    }
    if (access === 'not_set_up_other') {
      assert.match(await section.getByTestId('machine-access-author-only').innerText(),
        /^Only Ondrej can set this up: the work would run on their own machines, as them\.$/)
      assert.equal(await section.getByRole('button', { name: 'Set up machine access…' }).count(), 0)
    }
    if (access === 'not_set_up') {
      assert.match(text, /NES-140 Fix login redirect\s+waiting for machine access/)
      assert.equal(await section.getByRole('button', { name: 'Set up machine access…' }).count(), 1)
    }
    if (access === 'suspended') assert.match(text, /waiting: machine access is paused/)
    // The last wakes, in the words the deliveries say them — a machine back and a session's turn (T5) among them.
    const wakes = await section.getByTestId('machine-access-wakes').innerText()
    assert.match(wakes, /Woke the agent: the machine came back\./)
    assert.match(wakes, /Woke the agent: a coding session’s turn ended\./)
    await assertNoSidewaysScroll(page, `${name} machine access ${access}`)
    await section.screenshot({ path: shot(`machine-access-${access.replace(/_/g, '-')}`, width) })
    assert.deepEqual(errors, [], `${name} ${access}: no page errors`)
    await context.close()
  }
}

const setupForm = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page, section } = await openSection(browser, options, 'not_set_up')
  await section.getByRole('button', { name: 'Set up machine access…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set up machine access' })
  await dialog.getByTestId('machine-access-form').waitFor()
  const option = (label) => dialog.getByTestId('machine-option').filter({ hasText: label })
  const prepare = dialog.getByRole('button', { name: 'Prepare the card' })

  // Refused whatever is chosen: no reviewed bridge.
  assert.equal(await option('Bare').getByRole('checkbox').isDisabled(), true)
  assert.match(await option('Bare').getByTestId('machine-refusal').innerText(), /^Bare has no reviewed coding-sessions bridge\./)
  // Refused until the separate tick: it runs any command without asking.
  await option('Studio').getByRole('checkbox').check()
  assert.match(await option('Studio').getByTestId('machine-refusal').innerText(),
    /^Claude Code on Studio runs any command without asking, which needs “Let the coding agent run any command/)
  assert.equal(await prepare.isDisabled(), true, `${name}: a refused machine blocks the prepare`)
  await settled(page)
  await dialog.screenshot({ path: shot('machine-access-form-refused', width) })
  await option('Studio').getByRole('checkbox').uncheck()

  // The per-turn budget is held to the ticket's.
  await option('Minis').getByRole('checkbox').check()
  await dialog.getByLabel('Dollars per ticket').fill('4')
  assert.match(await option('Minis').getByTestId('machine-refusal').innerText(),
    /^Claude Code on Minis may spend \$5 a turn, more than the \$4 a ticket may spend\./)
  await dialog.getByLabel('Dollars per ticket').fill('20')
  assert.equal(await option('Minis').getByTestId('machine-refusal').count(), 0)
  assert.equal(await dialog.getByRole('checkbox', { name: 'site' }).isChecked(), true, 'the folders Minis has')
  assert.equal(await prepare.isDisabled(), false)
  await assertNoSidewaysScroll(page, `${name} machine access form`)
  await settled(page)
  await dialog.screenshot({ path: shot('machine-access-form', width) })

  // The server refuses a machine by name: the form stays open and says why.
  await prepare.click()
  await dialog.getByText('Minis is offline. Bring it online first.').waitFor()
  await settled(page)
  await dialog.screenshot({ path: shot('machine-access-server-refusal', width) })

  // Prepared: the one card, in the section, with its Review.
  await prepare.click()
  await dialog.waitFor({ state: 'detached' })
  const card = section.getByTestId('machine-access-card')
  await card.waitFor()
  const cardText = await card.innerText()
  assert.match(cardText, /Let CTO use Minis/)
  assert.match(cardText, /The agent may drive Claude Code sessions on these machines; it gets no other program/)
  const prepares = (await posted(page)).filter((entry) => entry.path.endsWith('/machine-access'))
  assert.deepEqual(prepares.at(-1)?.body, {
    allowAnyCommand: false, allowedRootNames: ['nessie', 'site'], executorIds: [MINIS],
    limits: { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 },
  })
  await card.scrollIntoViewIfNeeded()
  await settled(page)
  await section.screenshot({ path: shot('machine-access-card', width) })

  await card.getByRole('button', { name: 'Review and confirm' }).click()
  const review = page.getByRole('dialog', { name: 'Allow standing machine access' })
  await review.getByLabel('Confirm with current password').waitFor()
  assert.match(await review.innerText(), /CTO will work tickets from “Start work from In progress” on Minis\./)
  await settled(page)
  await page.screenshot({ path: shot('machine-access-review', width) })
  assert.deepEqual(errors, [], `${name} form: no page errors`)
  await context.close()
}

const endAccess = async (browser, { name, options }) => {
  const width = options.viewport.width
  const { context, errors, page, section } = await openSection(browser, options, 'live')
  await section.getByRole('button', { name: 'End' }).click()
  const confirm = page.getByRole('dialog', { name: 'End machine access?' })
  await confirm.waitFor()
  assert.match(await confirm.innerText(), /cancels the work of every ticket this trigger has working, queued or/)
  await settled(page)
  await page.screenshot({ path: shot('machine-access-end', width) })
  await confirm.getByRole('button', { name: 'End machine access' }).click()
  await confirm.waitFor({ state: 'detached' })
  assert.ok((await posted(page)).some((entry) => /\/api\/standing-policies\/.+\/end$/.test(entry.path)), `${name}: End posted`)
  assert.deepEqual(errors, [], `${name} end: no page errors`)
  await context.close()
}

export const machineAccess = async (browser, viewport) => {
  await states(browser, viewport)
  await setupForm(browser, viewport)
  await endAccess(browser, viewport)
}
