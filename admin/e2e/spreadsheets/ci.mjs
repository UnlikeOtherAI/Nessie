#!/usr/bin/env node
// CI owns the processes around this suite, the way `project-usability/ci.mjs`
// does for the usability runs.
//
// The ordinary runner adopts an already-listening API and admin, which is
// right for a development loop and wrong for CI: a suite that follows would
// inherit servers this one left running on the fixed ports. Here the two are
// started, handed to the run, and stopped again whatever happens.
//
// Phase 5 wires this into `.github/workflows/ci.yml` — one step running this
// file, and an artifact upload of `e2e/screenshots/spreadsheets`.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { databaseUrl } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const main = async () => {
  if (!databaseUrl()) throw new Error('spreadsheets CI requires DATABASE_URL')

  let api = null
  let admin = null
  try {
    // Not adopted, for the same reason `run.mjs` refuses to: CI's job is to
    // report on the commit it checked out, and a port that answers is not
    // evidence that it answers for this one.
    api = await startApi({ reuseExisting: false })
    admin = await startAdmin({ reuseExisting: false })
    const child = spawn(process.execPath, [resolve(here, 'run.mjs')], {
      env: process.env,
      stdio: 'inherit',
    })
    const result = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => done({ code, signal }))
    })
    if (result.code !== 0) {
      throw new Error(
        result.signal
          ? `spreadsheets runner stopped by ${result.signal}`
          : `spreadsheets runner exited ${result.code ?? 'without a status'}`,
      )
    }
    console.log('spreadsheets e2e: passed')
  } finally {
    await stopProcess(admin)
    await stopProcess(api)
  }
}

await main()
