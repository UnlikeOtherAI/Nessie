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
import { SCREENSHOT_DIR } from './lib/grid.mjs'
import { seedOrganisation } from './lib/seed.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// Named rather than discovered, so a case that fails to be written is a
// missing line here instead of silence. `agent-presence` is Phase 4's — it
// runs when that file exists and is skipped out loud when it does not, which
// is what lets the two phases land in either order.
const CASES = ['two-browsers', 'structural-rebase', 'phone-touch', 'agent-presence']

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

const main = async () => {
  if (!databaseUrl()) throw new Error('the spreadsheets suite requires DATABASE_URL')

  // The brute-force guard is 10 sign-ins per IP per 10 minutes, which is right
  // for the internet and wrong for a suite that signs two people in on every
  // run: the fourth local re-run inside ten minutes fails at the seed with a
  // 429 that has nothing to do with the code under test. Raised for this
  // process only, and never in a way a case can observe.
  process.env.NESSIE_RATE_LIMIT_LOGIN_IP_MAX ??= '200'
  process.env.NESSIE_RATE_LIMIT_LOGIN_ACCOUNT_MAX ??= '200'

  const api = await startApi()
  let admin = null
  let browser = null
  const results = []
  try {
    admin = await startAdmin()
    console.log(`spreadsheets e2e: API ${API_URL}, admin ${ADMIN_URL}`)
    const seed = await seedOrganisation(api)
    console.log(`spreadsheets e2e: seeded ${seed.people.map((p) => p.displayName).join(' and ')}`)
    browser = await launchBrowser()

    for (const name of CASES) {
      const path = resolve(here, 'cases', `${name}.mjs`)
      if (!existsSync(path)) {
        console.log(`spreadsheets e2e: ${name} — not present, skipped`)
        continue
      }
      const start = Date.now()
      try {
        const module = await import(path)
        const checks = await module.run({ browser, contextFor, seed })
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
