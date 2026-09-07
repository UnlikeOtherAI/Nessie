#!/usr/bin/env node
// CI owns the product processes around these usability browser runs. Their
// ordinary runners deliberately adopt an existing local loop and never stop
// it, which is right for development but would leave CI's fixed ports occupied
// for the connected-mail suite that follows.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { databaseUrl } from '../navigation/lib/config.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const runBrowserSuite = async (path, label) => {
  console.log(`${label} e2e: starting`)
  const child = spawn(process.execPath, [path], {
    env: process.env,
    stdio: 'inherit',
  })
  const result = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  if (result.code === 0) {
    console.log(`${label} e2e: passed`)
    return
  }
  throw new Error(
    result.signal
      ? `${label} runner stopped by ${result.signal}`
      : `${label} runner exited ${result.code ?? 'without a status'}`,
  )
}

const main = async () => {
  if (!databaseUrl()) throw new Error('project-usability CI requires DATABASE_URL')

  let api = null
  let admin = null
  try {
    api = await startApi()
    admin = await startAdmin()
    await runBrowserSuite(resolve(here, '../browser-cloud/run.mjs'), 'browser-cloud')
    await runBrowserSuite(resolve(here, 'run.mjs'), 'project-usability')
    await runBrowserSuite(resolve(here, '../connected-board-sources/run.mjs'), 'connected-board-sources')
  } finally {
    await stopProcess(admin)
    await stopProcess(api)
  }
}

await main()
