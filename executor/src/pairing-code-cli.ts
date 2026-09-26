import { createInterface } from 'node:readline/promises'

import { approveExecutorPairingOrigin } from '@nessie/schemas'

import {
  cancelPairingCode, confirmPairingCode, pairingCodeStatus, startPairingCode, type PairingCodeView,
} from './pairing-code.js'
import { workspaceFoldersFromInput } from './workspace-folder-arguments.js'
import { acquireDefaultPairingLease, defaultPairingDirectory, promoteDefaultPairing } from './pairing-code-directory.js'
import { createExecutorServiceEnvironment, enableExecutorService } from './service-linux.js'
import { WorkspaceCleanupRequiredError } from './workspace-retirement.js'

const value = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const selected = args[index + 1]
  if (!selected || selected.startsWith('--')) throw new Error('The command is missing a required setting.')
  return selected
}

const stdin = async (): Promise<Record<string, unknown>> => {
  let text = ''
  for await (const part of process.stdin) {
    text += String(part)
    if (text.length > 65_536) throw new Error('The pairing request is too large.')
  }
  const input: unknown = JSON.parse(text)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pairing input is invalid.')
  return input as Record<string, unknown>
}

const destination = (view: PairingCodeView): string => (
  `${view.organizationName ?? 'Nessie'}${view.teamName ? `, ${view.teamName}` : ''}`
)

const show = (view: PairingCodeView): void => {
  if (view.status === 'waiting') {
    process.stdout.write(`\n${[...(view.code ?? '')].map((digit) => `[ ${digit} ]`).join(' ')}\n`)
    process.stdout.write('In Nessie, open Admin › Computers › Pair a computer and paste this code.\n')
    process.stdout.write(`${view.machineName ?? 'This computer'} — fingerprint: ${view.fingerprint ?? ''}\n`)
  } else if (view.status === 'confirmation') {
    process.stdout.write(`Connect ${view.machineName ?? 'this computer'} to ${destination(view)}?\n`)
  } else if (view.status === 'paired' || view.status === 'alreadyPaired') {
    process.stdout.write(`This computer is paired to ${destination(view)}.\n`)
  } else process.stdout.write(view.status === 'expired' ? 'The code expired. Start pairing again.\n' : 'Pairing cancelled.\n')
}

/** An explicit --cli connection runs under this OS account on Windows too. */
export const pairingUsesWindowsTray = (args: string[], platform: NodeJS.Platform): boolean => (
  platform === 'win32'
  && ['pair', 'pairing-start'].includes(args[0] ?? 'pair')
  && !args.some((argument) => ['--cli', '--state-dir', '--json', '--enrollment'].includes(argument))
)

/** Native clients consume JSON; a terminal gets one complete guided pairing flow. */
export const runPairingCodeCli = async (
  args: string[], platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  const command = args[0] ?? 'pair'
  if (!['login', 'pairing-start', 'pairing-status', 'pairing-confirm', 'pairing-cancel', 'pair'].includes(command)) return false
  if (command === 'pair' && args.includes('--enrollment')) return false
  if (pairingUsesWindowsTray(args, platform)) {
    process.stdout.write('Open Nessie Executor in the Windows tray and choose Pair with Nessie.\n')
    return true
  }
  const explicitDirectory = value(args, '--state-dir')
  const executorId = value(args, '--executor')
  if (args.includes('--replace') && !explicitDirectory && !executorId) {
    throw new Error('Choose the connection to replace with --executor <id> from status, or --state-dir.')
  }
  const json = args.includes('--json')
  const rootLease = explicitDirectory ? null : await acquireDefaultPairingLease()
  try {
    const directory = explicitDirectory ?? await defaultPairingDirectory(executorId)
    let view: PairingCodeView
    if (command === 'pairing-status') view = await pairingCodeStatus(directory)
    else if (command === 'pairing-confirm') {
      const digest = value(args, '--claim-digest')
      if (!digest) throw new Error('Review the organisation and team before confirming.')
      view = await confirmPairingCode(directory, digest)
    } else if (command === 'pairing-cancel') view = await cancelPairingCode(directory)
    else {
      const approved = approveExecutorPairingOrigin(value(args, '--api') ?? 'nessie', {
        allowLocalDevelopment: process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1',
      })
      if (!approved.ok) throw new Error(approved.reason)
      const input = args.includes('--pairing-input-stdin') ? await stdin() : {
        workspaceRoot: value(args, '--workspace') ?? process.cwd(), replace: args.includes('--replace'),
      }
      view = await startPairingCode({
        apiBaseUrl: approved.origin, replace: input.replace === true, stateDir: directory,
        workspaceFolders: workspaceFoldersFromInput(input, 'Workspace folder'),
      })
      if (!json && process.stdin.isTTY) {
        const terminal = createInterface({ input: process.stdin, output: process.stdout })
        try {
          if (view.status === 'alreadyPaired') {
            show(view)
            if ((await terminal.question('Replace this pairing? Type yes to continue: ')).trim().toLowerCase() !== 'yes') return true
            view = await startPairingCode({
              apiBaseUrl: approved.origin, replace: true, stateDir: directory,
              workspaceFolders: workspaceFoldersFromInput(input, 'Workspace folder'),
            })
          }
          show(view)
          while (view.status === 'waiting') {
            await new Promise((finish) => setTimeout(finish, 3_000))
            view = await pairingCodeStatus(directory)
            const seconds = Math.max(0, Math.ceil((Date.parse(view.expiresAt ?? '') - Date.now()) / 1_000))
            process.stdout.write(`\rCode expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}   `)
          }
          process.stdout.write('\n')
          if (view.status === 'confirmation' && view.claimDigest) {
            show(view)
            view = (await terminal.question('Type yes to connect, or press Enter to cancel: ')).trim().toLowerCase() === 'yes'
              ? await confirmPairingCode(directory, view.claimDigest) : await cancelPairingCode(directory)
          }
        } finally { terminal.close() }
      }
    }
    if (!explicitDirectory && view.status === 'paired' && view.executorId) {
      await promoteDefaultPairing(directory, view.executorId)
      if (!json && process.stdin.isTTY && platform === 'linux'
        && ['login', 'pair', 'pairing-start'].includes(command)) {
        const environment = createExecutorServiceEnvironment()
        await enableExecutorService({ executorId: view.executorId, assumeYes: true }, {
          ...environment, write: () => undefined,
        })
        process.stdout.write('Nessie Executor is running and will start automatically with this computer.\n')
      }
    }
    if (json) process.stdout.write(`${JSON.stringify(view)}\n`)
    else show(view)
    return true
  } catch (error) {
    if (!json || !(error instanceof WorkspaceCleanupRequiredError)) throw error
    process.stdout.write(`${JSON.stringify({ error: { code: 'workspace_cleanup_required' } })}\n`)
    process.exitCode = 1
    return true
  } finally { await rootLease?.release() }
}
