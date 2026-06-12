import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const formatCommandError = (error: unknown, command: string, args: string[]): Error => {
  if (!(error instanceof Error)) {
    return new Error(`${command} ${args.join(' ')} failed`)
  }

  const withStreams = error as Error & {
    stderr?: string
    stdout?: string
  }
  const stderr = typeof withStreams.stderr === 'string' ? withStreams.stderr.trim() : ''
  const stdout = typeof withStreams.stdout === 'string' ? withStreams.stdout.trim() : ''
  const detail = stderr || stdout || error.message

  return new Error(`${command} ${args.join(' ')} failed: ${detail}`)
}

export const runCommand = async (
  command: string,
  args: string[],
): Promise<{ stderr: string; stdout: string }> => {
  try {
    const result = await execFile(command, args, {
      maxBuffer: 10 * 1024 * 1024,
    })
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } catch (error) {
    throw formatCommandError(error, command, args)
  }
}

export const runJsonCommand = async <T>(
  command: string,
  args: string[],
): Promise<T> => {
  const { stdout } = await runCommand(command, args)
  return JSON.parse(stdout) as T
}
