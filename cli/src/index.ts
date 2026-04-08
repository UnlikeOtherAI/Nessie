#!/usr/bin/env node

import { runLocalCommand } from './local.js'

const printHelp = (): void => {
  console.log([
    'nessie local up [--docker|--no-docker] [--no-open]',
    'nessie local down',
    'nessie local status',
    'nessie local logs [api|worker|admin|postgres] [--no-follow]',
    'nessie local doctor',
    'nessie local reset --yes',
  ].join('\n'))
}

const main = async (): Promise<void> => {
  const [scope, ...rest] = process.argv.slice(2)

  if (scope === 'local') {
    await runLocalCommand(rest)
    return
  }

  printHelp()
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
