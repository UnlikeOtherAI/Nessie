#!/usr/bin/env node
import { claimExecutor, heartbeatExecutor, serveExecutor } from './daemon.js'
import { pairExecutor } from './pair.js'
import { loadExecutorState } from './state-store.js'

type ParsedCommand =
  | { kind: 'pair'; apiBaseUrl: string; challenge: string; enrollmentId: string; stateDir: string }
  | { kind: 'connect'; stateDir: string }
  | { kind: 'heartbeat'; stateDir: string }
  | { kind: 'serve'; stateDir: string }

const usage = (): never => {
  throw new Error(
    'Usage: nessie-executor pair --api <https://api.example> --enrollment <uuid> '
    + '--challenge <token> --state-dir <owner-only-path>\n'
    + '       nessie-executor connect|heartbeat|serve --state-dir <owner-only-path>',
  )
}

const option = (args: string[], name: string): string => {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) return usage()
  return value
}

const secureApiUrl = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('--api must be an HTTPS URL.')
  }
  if (parsed.protocol !== 'https:') throw new Error('--api must be an HTTPS URL.')
  return parsed.toString().replace(/\/$/, '')
}

export const parseCommand = (args: string[]): ParsedCommand => {
  const [command] = args
  if (command === 'pair') {
    return {
      apiBaseUrl: secureApiUrl(option(args, '--api')),
      challenge: option(args, '--challenge'),
      enrollmentId: option(args, '--enrollment'),
      kind: 'pair',
      stateDir: option(args, '--state-dir'),
    }
  }
  if (command === 'connect' || command === 'heartbeat' || command === 'serve') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  return usage()
}

export const run = async (args: string[]): Promise<void> => {
  const command = parseCommand(args)
  if (command.kind === 'pair') {
    const paired = await pairExecutor(command)
    process.stdout.write(
      `Pairing request submitted. Confirm fingerprint ${paired.fingerprint} in Nessie, then run connect.\n`,
    )
    return
  }
  const state = await loadExecutorState(command.stateDir)
  if (command.kind === 'connect') {
    await claimExecutor(command.stateDir, state)
    process.stdout.write('Executor daemon connection established.\n')
    return
  }
  if (command.kind === 'heartbeat') {
    await heartbeatExecutor(state)
    process.stdout.write('Executor heartbeat accepted.\n')
    return
  }
  await serveExecutor(command.stateDir, state)
}

if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
