#!/usr/bin/env node
// CI's named entry for the spreadsheets suite, the way `project-usability` has
// one.
//
// It does **not** start the API and admin, although a CI entry usually does.
// `run.mjs` already owns that lifecycle here, and owns it with exactly the
// property CI needs: it starts both with `reuseExisting: false`, raises its own
// API's login rate limit, and stops them in a `finally`. Starting a second pair
// around it collided with the first — `API port 5454 is already in use; this
// evaluation requires a fresh API from its own worktree` — so wiring the file
// as it stood would have failed the step on every run without ever opening a
// browser.
//
// What this file is still for: one stable path for the workflow to name, one
// place to fail loudly when `DATABASE_URL` is missing, and a child process, so
// an abort inside the Rust engine cannot take this step's own reporting with
// it.
//
// `.github/workflows/ci.yml` runs it in Navigation Transitions and uploads
// `e2e/screenshots/spreadsheets`.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { databaseUrl } from '../navigation/lib/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const main = async () => {
  if (!databaseUrl()) throw new Error('spreadsheets CI requires DATABASE_URL')

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
}

await main()
