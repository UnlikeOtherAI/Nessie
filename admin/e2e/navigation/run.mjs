#!/usr/bin/env node
// The navigation transition suite (docs/navigation/overview.md → "Verification";
// §4.19 of docs/done/2026-09-01-navigation-motion-system.md).
//
//   pnpm --filter @nessie/admin test:e2e:navigation
//
// It brings up the real API (5454) and the real admin (5455) against
// DATABASE_URL, seeds one organisation with a project and two channels,
// drives Chromium at three viewports, and for each transition freezes the
// real animation through `document.getAnimations()` at 0 %, 50 % and 100 %,
// asserts positions and scrollLeft numerically, and saves the frames under
// e2e/screenshots/navigation/<case>/.
//
// With no reachable database it skips and exits 0: everything it asserts
// needs a running product, and a red suite that only means "no Postgres
// here" teaches people to ignore it.
import { mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { CASES } from './cases/index.mjs'
import { CaseFailure } from './lib/expect.mjs'
import { SCREENSHOT_ROOT, databaseUrl, keepServers } from './lib/config.mjs'
import { launchBrowser, openViewportContext } from './lib/browser.mjs'
import { seedWorkspace } from './lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from './lib/servers.mjs'

const parseArgs = (argv) => {
  const options = { cases: null, viewports: null }
  for (const argument of argv) {
    const [flag, value] = argument.split('=')
    if (flag === '--case' && value) options.cases = value.split(',')
    if (flag === '--viewport' && value) options.viewports = value.split(',')
  }
  return options
}

const skip = (reason) => {
  console.log(`navigation e2e: SKIPPED — ${reason}`)
  process.exit(0)
}

// A TCP probe rather than a Postgres client: `pg` is a dependency of the API,
// not of the admin, and the only question here is whether a database is there
// at all. Anything past "something is listening" is the API's to report.
const reachable = (url) => new Promise((resolve) => {
  let target
  try {
    target = new URL(url)
  } catch {
    resolve({ ok: false, reason: `DATABASE_URL is not a URL: ${url}` })
    return
  }
  const socket = connect({
    host: target.hostname || '127.0.0.1',
    port: Number(target.port || 5432),
  })
  const finish = (result) => { socket.destroy(); resolve(result) }
  socket.setTimeout(3_000)
  socket.once('connect', () => finish({ ok: true }))
  socket.once('timeout', () => finish({ ok: false, reason: 'connection timed out' }))
  socket.once('error', (error) => finish({ ok: false, reason: error.message }))
})

const printCase = (name, result) => {
  const passed = result.checks?.filter((check) => check.passed).length ?? 0
  const total = result.checks?.length ?? 0
  console.log(`  ✓ ${name} — ${passed}/${total} checks, ${result.frames.length} frame(s)`)
}

const printFailure = (name, error) => {
  console.log(`  ✗ ${name} — ${error.message}`)
  for (const failure of error.failures ?? []) {
    console.log(`      ${failure.label}: ${failure.detail}`)
  }
  if (!(error instanceof CaseFailure)) console.log(error.stack ?? '')
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const database = databaseUrl()
  if (!database) skip('DATABASE_URL is not set')
  const connection = await reachable(database)
  if (!connection.ok) skip(`the database at DATABASE_URL is unreachable (${connection.reason})`)

  const selected = CASES.filter((entry) => (
    (!options.cases || options.cases.includes(entry.name))
    && (!options.viewports || options.viewports.includes(entry.viewport))
  ))
  if (selected.length === 0) skip('no case matched the --case/--viewport filters')

  await rm(SCREENSHOT_ROOT, { force: true, recursive: true })
  await mkdir(SCREENSHOT_ROOT, { recursive: true })

  let api = null
  let admin = null
  let browser = null
  const failures = []

  try {
    api = await startApi()
    admin = await startAdmin()
    const seed = await seedWorkspace(api)
    console.log(
      `navigation e2e: signed in via ${seed.origin}; `
      + `project "${seed.project.name}", channels ${seed.channels.map((c) => c.slug).join(', ')}`,
    )

    browser = await launchBrowser()
    const contexts = new Map()
    for (const entry of selected) {
      if (!contexts.has(entry.viewport)) {
        contexts.set(
          entry.viewport,
          await openViewportContext(browser, { name: entry.viewport, token: seed.token }),
        )
      }
      const shell = contexts.get(entry.viewport)
      const target = await shell.newPage()
      try {
        const result = await entry.run({ page: target.page, seed, viewport: shell.viewport })
        printCase(entry.name, result)
      } catch (error) {
        failures.push(entry.name)
        printFailure(entry.name, error)
      }
      if (target.errors.length > 0) {
        console.log(`      page errors: ${target.errors.slice(0, 3).join(' | ')}`)
      }
      await target.close()
    }
    for (const shell of contexts.values()) await shell.close()
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (!keepServers()) {
      await stopProcess(admin)
      await stopProcess(api)
    }
  }

  console.log(`navigation e2e: frames in ${SCREENSHOT_ROOT}`)
  if (failures.length > 0) {
    console.error(`navigation e2e: FAILED — ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log(`navigation e2e: ${selected.length} case(s) passed`)
}

await main()
