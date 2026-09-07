#!/usr/bin/env node
// CI owns the product processes around the project-usability browser run. The
// ordinary runner deliberately adopts an existing local loop and never stops
// it, which is right for development but would leave CI's fixed ports occupied
// for the connected-mail suite that follows.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { databaseUrl } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const runProjectUsability = async () => {
  const child = spawn(process.execPath, [resolve(here, 'run.mjs')], {
    env: process.env,
    stdio: 'inherit',
  })
  const result = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  if (result.code === 0) return
  throw new Error(
    result.signal
      ? `project-usability runner stopped by ${result.signal}`
      : `project-usability runner exited ${result.code ?? 'without a status'}`,
  )
}

const main = async () => {
  if (!databaseUrl()) throw new Error('project-usability CI requires DATABASE_URL')

  let api = null
  let admin = null
  try {
    api = await startApi()
    admin = await startAdmin()
    await runProjectUsability()
  } finally {
    await stopProcess(admin)
    await stopProcess(api)
  }
}

await main()
