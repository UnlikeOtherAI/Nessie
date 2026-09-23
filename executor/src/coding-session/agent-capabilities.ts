import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { CommandRunner } from './agent-env.js'
import { claudeArguments } from './claude-adapter.js'
import { codexArguments } from './codex-adapter.js'
import type { CodingAgentConfig } from './config.js'
import { resolveProgramPath } from './program-path.js'
import { readJson, writeJsonAtomic } from './session-files.js'
import type { CodingAgentName } from './types.js'

/**
 * What an installed coding CLI offers, read from its own `--help`, so a CLI
 * too old for a flag the adapter passes is refused before it starts rather
 * than failing on its first message with an argument error nobody reads.
 *
 * The flags required are the adapter's own argv, fresh and resumed, so a flag
 * the adapter gains is required with it. For Claude Code that is `-p`,
 * `--input-format`, `--output-format`, `--verbose`, `--replay-user-messages`,
 * `--session-id`, `--resume`, `--permission-prompts` and
 * `--append-system-prompt`, then `--permission-mode`, `--allowedTools`,
 * `--disallowedTools`, `--model` and `--max-budget-usd` when the
 * configuration turns them on, and every flag in the owner's `args`. For Codex
 * it is the `exec` and `exec resume` subcommands (each help's `Usage:` line
 * must name it), `-C` and `--json` on `exec`, `--json` on `exec resume`, which
 * parses it there, `-m` with a model, and the owner's `args`. A configured
 * `permissionMode` must be one of the choices `--permission-mode` lists.
 *
 * Help is read within a time and a size bound, and cached in the bridge's
 * state directory per agent, program path, size and modification time, so an
 * updated CLI is read afresh and an unchanged one once. A help that could not
 * be read is not cached: a machine too busy to answer in time is not an
 * outdated one for ever.
 */

export type HelpDigest = {
  usage: string
  flags: string[]
  /** Commander's `(choices: …)`, per flag. */
  choices: Record<string, string[]>
}

/** One digest per help read: `''` for the CLI itself, `exec` and `exec resume` for Codex. */
export type AgentCapabilities = Record<string, HelpDigest>

export type CapabilityCheck =
  | { ok: true }
  | { ok: false; reason: 'agent_outdated' | 'permission_mode_unsupported'; missing: string[] }

const HELP_TIMEOUT_MS = 15_000
const HELP_MAX_BYTES = 256 * 1024
const CACHE_ENTRIES = 8
const MAX_FLAGS = 400

const HELP_COMMANDS: Record<CodingAgentName, { help: string; args: string[] }[]> = {
  claude: [{ help: '', args: ['--help'] }],
  codex: [{ help: 'exec', args: ['exec', '--help'] }, { help: 'exec resume', args: ['exec', 'resume', '--help'] }],
}

/** An option line: commander indents by two, clap by two or six; descriptions sit further in. */
const OPTION_LINE = /^ {1,6}-/u
const FLAG = /^--?[A-Za-z]/u

export const parseHelpText = (text: string): HelpDigest => {
  const lines = text.split(/\r?\n/u)
  const usage = lines.map((line) => line.trim()).find((line) => /^usage:/iu.test(line))?.slice(0, 200) ?? ''
  const flags = new Set<string>()
  const choices: Record<string, string[]> = {}
  lines.forEach((line, index) => {
    if (!OPTION_LINE.test(line)) return
    // `-r, --resume [value]`, `--allowedTools, --allowed-tools <tools...>`: the names before the description.
    const names = (line.trim().split(/ {2,}/u)[0] ?? '').split(/[\s,|]+/u)
      .filter((token) => FLAG.test(token)).map((token) => token.replace(/[=[<].*$/u, ''))
    for (const name of names) if (flags.size < MAX_FLAGS) flags.add(name)
    // Its description runs to the next option or the next section heading.
    let block = line
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = lines[next]!
      if (OPTION_LINE.test(following) || /^\S/u.test(following)) break
      block += ` ${following.trim()}`
    }
    const listed = /\(choices:\s*([^)]*)\)/u.exec(block.replace(/\s+/gu, ' '))?.[1]
    if (!listed) return
    const quoted = listed.split(/,\s*(?:default|preset):/u)[0]!
    const values = [...quoted.matchAll(/"([^"]{1,64})"/gu)].map((match) => match[1]!)
    for (const name of names) choices[name] = values.slice(0, 32)
  })
  return { usage, flags: [...flags], choices }
}

/** The flags in an argv, as a help lists them: `--name=value` by its name, `-Xvalue` by `-X`. */
const flagsIn = (argv: readonly string[]): string[] => [...new Set(argv.filter((token) => FLAG.test(token))
  .map((token) => (token.startsWith('--') ? token.replace(/=.*$/u, '') : token.slice(0, 2))))]

const SAMPLE_ID = '00000000-0000-4000-8000-000000000000'

type Requirement = { help: string; flags: string[] }

const requirements = (agent: CodingAgentName, config: CodingAgentConfig, maxBudgetUsd?: number): Requirement[] => {
  // The command's own prefix (`codex.js` after `node`) is not the CLI's to parse.
  const own = (argv: string[]): string[] => argv.slice(config.command.length - 1)
  if (agent === 'claude') {
    const argv = [false, true].flatMap((resume) => own(claudeArguments(config, {
      sessionId: SAMPLE_ID, resume, ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    })))
    return [{ help: '', flags: flagsIn(argv) }]
  }
  const fresh = own(codexArguments(config, { folder: '.' }))
  const resumed = own(codexArguments(config, { folder: '.', threadId: SAMPLE_ID }))
  // The subcommand, not a model that happens to be called `resume`: only the thread id and `--json -` follow it.
  const at = resumed.lastIndexOf('resume')
  return [
    { help: 'exec', flags: flagsIn([...fresh, ...resumed.slice(0, at)]) },
    { help: 'exec resume', flags: flagsIn(resumed.slice(at + 2)) },
  ]
}

const namesCommand = (usage: string, help: string): boolean => (
  help === '' || new RegExp(`(?:^|\\s)${help.split(' ').join('\\s+')}(?:\\s|$)`, 'u').test(usage)
)

export const checkAgentCapabilities = (input: {
  agent: CodingAgentName
  config: CodingAgentConfig
  capabilities: AgentCapabilities
  maxBudgetUsd?: number
}): CapabilityCheck => {
  const missing: string[] = []
  for (const requirement of requirements(input.agent, input.config, input.maxBudgetUsd)) {
    const digest = input.capabilities[requirement.help]
    if (!digest || !namesCommand(digest.usage, requirement.help)) {
      missing.push(requirement.help || '--help')
      continue
    }
    missing.push(...requirement.flags.filter((flag) => !digest.flags.includes(flag)))
  }
  if (missing.length > 0) return { ok: false, reason: 'agent_outdated', missing }
  const mode = input.agent === 'claude' ? input.config.permissionMode : undefined
  if (mode !== undefined && !(input.capabilities['']?.choices['--permission-mode'] ?? []).includes(mode)) {
    return { ok: false, reason: 'permission_mode_unsupported', missing: [`--permission-mode ${mode}`] }
  }
  return { ok: true }
}

const stamp = async (path: string): Promise<string | undefined> => {
  const real = await realpath(path).catch(() => path)
  const info = await stat(real).catch(() => undefined)
  return info?.isFile() ? `${real}|${info.size}|${info.mtimeMs}` : undefined
}

/** The cache key: the agent, and each file of its command by real path, size and modification time. */
const programFingerprint = async (
  agent: CodingAgentName, command: readonly string[], env: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const [program, ...prefix] = command
  // The host passes it resolved already; a bare name is found as `program-path.ts` finds one.
  const located = program === undefined ? undefined : await resolveProgramPath(program, env)
  const programStamp = located === undefined ? undefined : await stamp(located)
  if (programStamp === undefined) return undefined
  const rest = await Promise.all(prefix.map(async (part) => (isAbsolute(part) ? await stamp(part) ?? part : part)))
  return JSON.stringify([agent, programStamp, ...rest])
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const validCapabilities = (value: unknown): value is AgentCapabilities => (
  !!value && typeof value === 'object' && Object.values(value).every((digest: unknown) => {
    const entry = digest as Partial<Record<keyof HelpDigest, unknown>> | null
    return !!entry && typeof entry.usage === 'string' && strings(entry.flags) && !!entry.choices
      && typeof entry.choices === 'object' && Object.values(entry.choices).every(strings)
  })
)

type CacheEntry = { key: string; capabilities: AgentCapabilities }

const cachedEntries = async (file: string): Promise<CacheEntry[]> => {
  const read = await readJson<{ entries?: unknown }>(file)
  return (Array.isArray(read?.entries) ? read.entries : []).filter((entry: unknown): entry is CacheEntry => (
    !!entry && typeof (entry as CacheEntry).key === 'string' && validCapabilities((entry as CacheEntry).capabilities)
  ))
}

export const readAgentCapabilities = async (input: {
  agent: CodingAgentName
  command: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  run: CommandRunner
  /** The bridge state's `agent-help.json`; without one, help is read every time. */
  cacheFile?: string
}): Promise<AgentCapabilities> => {
  const key = input.cacheFile ? await programFingerprint(input.agent, input.command, input.env) : undefined
  const entries = key ? await cachedEntries(input.cacheFile!) : []
  const cached = entries.find((entry) => entry.key === key)
  if (cached) return cached.capabilities
  const [program, ...prefix] = input.command
  const capabilities: AgentCapabilities = {}
  const answers = await Promise.all(HELP_COMMANDS[input.agent].map(async ({ help, args }) => ({
    help,
    outcome: await input.run(program!, [...prefix, ...args], {
      env: input.env, cwd: input.cwd, timeoutMs: HELP_TIMEOUT_MS, maxBytes: HELP_MAX_BYTES,
    }),
  })))
  for (const { help, outcome } of answers) {
    if (outcome.code === 0 && outcome.stdout.trim()) capabilities[help] = parseHelpText(outcome.stdout)
  }
  if (key && Object.keys(capabilities).length === answers.length) {
    const kept = entries.filter((entry) => entry.key !== key).slice(-(CACHE_ENTRIES - 1))
    const next = { version: 1, entries: [...kept, { key, capabilities }] }
    await writeJsonAtomic(input.cacheFile!, next).catch(() => undefined)
  }
  return capabilities
}
