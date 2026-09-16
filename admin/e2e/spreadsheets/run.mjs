#!/usr/bin/env node
// The spreadsheets browser suite: two real browsers, two real accounts, one
// API, one database, nothing stubbed.
//
//   DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:spreadsheets
//
// Ports are the repo's fixed 5454/5455, or `NAV_E2E_API_PORT` /
// `NAV_E2E_ADMIN_PORT` when another worktree owns them — never a port picked
// to dodge a conflict (CLAUDE.md → "Ports").
//
// Every case gets its own spreadsheet and its own browser contexts, and every
// case runs even if an earlier one failed: the screenshots and the per-check
// report are worth more than an early exit, and a live-collaboration failure
// is usually only legible next to the case that still works.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, API_URL, databaseUrl } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'
import { CaseFailure } from '../navigation/lib/expect.mjs'
import { SCREENSHOT_DIR, openSpreadsheet } from './lib/grid.mjs'
import { createAgentRunner, seedAgent } from './lib/agent.mjs'
import { createSpreadsheet, seedOrganisation } from './lib/seed.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// Named rather than discovered, so a case that fails to be written is a
// missing line here instead of silence. `agent-presence` is Phase 4's — it
// runs when that file exists and is skipped out loud when it does not, which
// is what lets the two phases land in either order.
const CASES = ['two-browsers', 'structural-rebase', 'offline-queue', 'phone-touch', 'agent-presence']

/**
 * Cases that exist but cannot run yet, with the reason printed on every run.
 *
 * **Not a way to silence a failure.** A case here is reported as pending, is
 * never counted as coverage, and the reason says exactly what is missing. The
 * alternative was a CI step red on every commit, which teaches people to
 * ignore it — and Phase 5 wired this suite into CI.
 *
 * Delete an entry the moment its reason is gone; never add one for a case that
 * fails on the code under test.
 */
const PENDING = new Map([
  [
    'agent-presence',
    "Phase 4's: `runAgentScenario` is still the placeholder in `caseContext` "
      + 'below, and the case reads cells as `[data-cell="B2"]`, which nothing '
      + "renders — IronCalc's grid is a canvas, and `lib/grid.mjs` is how the "
      + 'other cases read it',
  ],
])

/**
 * One browser context per person per case.
 *
 * The session token is planted in localStorage before the first script runs,
 * exactly as the navigation suite does, so the suite never drives the login
 * form — and, more to the point, so the two browsers are genuinely two
 * sessions rather than one context with two tabs.
 */
const contextFor = async (browser, person, options = {}) => {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { height: 900, width: 1280 },
    ...options,
  })
  await context.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value) },
    ['nessie.admin.token', person.token],
  )
  context.setDefaultTimeout(30_000)
  return context
}

/**
 * What a case is handed.
 *
 * Two vocabularies, deliberately: this phase's cases drive two browsers
 * themselves (`browser`, `contextFor`), and Phase 4's agent case wants one
 * signed-in person already sitting in front of the document (`page`,
 * `openSheet`). The person's tab is opened blank and navigates nowhere unless
 * `openSheet` is called, so a case that ignores it never becomes a third peer
 * in somebody else's presence assertion.
 */
const caseContext = async (browser, seed, agentRunner) => {
  const context = await contextFor(browser, seed.people[0])
  const page = await context.newPage()
  return {
    browser,
    contextFor,
    close: () => context.close(),
    openSheet: (pageId) => openSpreadsheet(page, { pageId, spaceId: seed.spaceId }),
    page,
    /**
     * Runs a named mock-LLM scenario's tool calls as the seeded agent, through
     * the worker's own builtin dispatch, publishing on the same database this
     * API replica is listening to. Deliberately **not** awaited by the caller
     * before it looks at the browser: the drafts only exist mid-flight.
     */
    runAgentScenario: (input) => agentRunner.runAgentScenario({ agent: seed.agent, ...input }),
    seed: {
      ...seed,
      createSpreadsheet: (input) => createSpreadsheet({
        spaceId: seed.spaceId,
        token: seed.ownerToken,
        ...input,
      }),
    },
  }
}

const main = async () => {
  if (!databaseUrl()) throw new Error('the spreadsheets suite requires DATABASE_URL')

  // The brute-force guard is 10 sign-ins per IP per 10 minutes, which is right
  // for the internet and wrong for a suite that signs two people in on every
  // run: the fourth local re-run inside ten minutes fails at the seed with a
  // 429 that has nothing to do with the code under test. Raised for this
  // process only, and never in a way a case can observe.
  process.env.NESSIE_RATE_LIMIT_LOGIN_IP_MAX ??= '200'
  process.env.NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX ??= '200'

  // **Never adopt a server that is already listening.** The navigation suites
  // reuse a local `pnpm dev` on purpose, and it is right for them. It is wrong
  // here: this suite asserts what *this* checkout's admin and API do, and a
  // sibling worktree holding the port would have it drive somebody else's code
  // and report the result as this branch's. It happened — a run adopted
  // another worktree's API, seeded nothing, and failed on "No users exist yet"
  // with nothing in the message to say whose database it was talking to.
  const api = await startApi({ reuseExisting: false })
  let admin = null
  let agentRunner = null
  let browser = null
  const results = []
  try {
    admin = await startAdmin({ reuseExisting: false })
    console.log(`spreadsheets e2e: API ${API_URL}, admin ${ADMIN_URL}`)
    const seed = await seedOrganisation(api)
    // The agent is one of the collaborators, seeded beside the people: the
    // agent case needs an identity to edit as and the others simply never use
    // it.
    seed.agent = await seedAgent(seed)
    agentRunner = await createAgentRunner(seed)
    console.log(
      `spreadsheets e2e: seeded ${seed.people.map((p) => p.displayName).join(' and ')}`
      + ` plus ${seed.agent.name}`,
    )
    browser = await launchBrowser()

    for (const name of CASES) {
      const path = resolve(here, 'cases', `${name}.mjs`)
      if (!existsSync(path)) {
        console.log(`spreadsheets e2e: ${name} — not present, skipped`)
        continue
      }
      if (PENDING.has(name)) {
        console.log(`spreadsheets e2e: ${name} — PENDING, not run: ${PENDING.get(name)}`)
        continue
      }
      const start = Date.now()
      try {
        const module = await import(path)
        // A case exports `run`, or an object with one. Both shapes are in the
        // suite because the phases wrote their cases against each other's
        // description of the harness rather than against the harness, and a
        // three-line reader here is cheaper than a rename in somebody else's
        // file.
        const run = typeof module.run === 'function'
          ? module.run
          : Object.values(module).find((value) => typeof value?.run === 'function')?.run
        if (!run) throw new Error(`${name} exports no run()`)
        const context = await caseContext(browser, seed, agentRunner)
        let checks
        try {
          checks = await run(context)
        } finally {
          await context.close()
        }
        results.push({ checks, name, passed: true })
        console.log(`spreadsheets e2e: ${name} passed (${checks.length} checks, ${Date.now() - start} ms)`)
      } catch (error) {
        const checks = error instanceof CaseFailure ? error.failures : []
        results.push({ checks, error, name, passed: false })
        console.log(`spreadsheets e2e: ${name} FAILED (${Date.now() - start} ms)`)
        for (const check of checks) console.log(`    ✗ ${check.label} — ${check.detail}`)
        if (!(error instanceof CaseFailure)) console.log(`    ${error.stack ?? error}`)
      }
    }
  } finally {
    await agentRunner?.close()
    await browser?.close()
    await stopProcess(admin)
    await stopProcess(api)
  }

  console.log(`spreadsheets e2e: screenshots in ${SCREENSHOT_DIR}`)
  const failed = results.filter((result) => !result.passed)
  if (failed.length > 0) {
    throw new Error(`spreadsheets e2e: ${failed.map((result) => result.name).join(', ')} failed`)
  }
  console.log(`spreadsheets e2e: ${results.length} case(s) passed`)
}

await main()
