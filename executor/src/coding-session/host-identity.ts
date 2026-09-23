import { homedir, hostname, userInfo } from 'node:os'
import { basename } from 'node:path'

/**
 * The OS user and host names, which a coding agent's output repeats without
 * any path around them: git's `unable to auto-detect email address (got
 * 'ondre@Minis.(none)')` in the live Windows run, `npm whoami`, a Git Bash
 * prompt, `whoami` itself. Each becomes `<user>` or `<host>` before it
 * leaves the machine.
 *
 * Every spelling this process can see is collected: `os.userInfo()`,
 * `USERNAME`, `USER`, `LOGNAME` and the home directory's own name for the
 * user; `os.hostname()` and `COMPUTERNAME`, each whole and by its first label,
 * `<short>.<USERDNSDOMAIN>` on a Windows domain, and the NetBIOS form (the
 * first 15 characters) on Windows for the host. The MCP SDK hands the bridge
 * a minimal environment, so the `os` answers are the ones that always arrive.
 *
 * A name is matched as a whole word and case-insensitively. One shorter than
 * three characters, and one any machine may carry (`root`, `admin`,
 * `localhost`, …), is left alone: it would rewrite ordinary words and hide
 * nobody.
 */
export const USER_PLACEHOLDER = '<user>'
export const HOST_PLACEHOLDER = '<host>'

export type HostIdentity = { users: readonly string[]; hosts: readonly string[] }

export const NO_HOST_IDENTITY: HostIdentity = { users: [], hosts: [] }

const MIN_NAME_LENGTH = 3
const MAX_NAMES = 16
const GENERIC_NAMES = new Set([
  'root', 'user', 'admin', 'administrator', 'guest', 'nobody', 'system', 'localhost', 'localhost.localdomain',
])

const attempt = (read: () => string): string | undefined => {
  try {
    return read()
  } catch {
    // os.userInfo() throws for a uid with no passwd entry (a container).
    return undefined
  }
}

/** Trimmed, long enough, not generic, one entry per name however it is cased. */
export const identityNames = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = value?.trim()
    if (!name || name.length < MIN_NAME_LENGTH || /[\p{Cc}]/u.test(name)) continue
    const folded = name.toLowerCase()
    if (GENERIC_NAMES.has(folded) || seen.has(folded)) continue
    seen.add(folded)
    names.push(name)
  }
  return names.slice(0, MAX_NAMES)
}

export const readHostIdentity = (
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): HostIdentity => {
  const hosts: string[] = []
  for (const name of [attempt(hostname), env.COMPUTERNAME]) {
    if (!name) continue
    const short = name.split('.')[0]!
    hosts.push(name, short)
    if (platform === 'win32') hosts.push(short.slice(0, 15))
    if (env.USERDNSDOMAIN) hosts.push(`${short}.${env.USERDNSDOMAIN}`)
  }
  return {
    users: identityNames([
      attempt(() => userInfo().username), env.USERNAME, env.USER, env.LOGNAME, attempt(() => basename(homedir())),
    ]),
    hosts: identityNames(hosts),
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** A session id, an agent session id: a hex group of one may spell a short host name. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The rewrite itself. `keep` are the placeholders already written (`<host
 * path>`, `<root>`, `<account>`, …), which are never rewritten again, so a
 * user who happens to be called `host` does not turn `<host path>` inside out.
 */
export const createIdentityRewrite = (
  identity: HostIdentity, keep: readonly string[],
): ((text: string) => string) | undefined => {
  const hosts = identityNames(identity.hosts)
  const hostSet = new Set(hosts.map((name) => name.toLowerCase()))
  const names = [
    ...hosts.map((name) => ({ name, placeholder: HOST_PLACEHOLDER })),
    ...identityNames(identity.users).filter((name) => !hostSet.has(name.toLowerCase()))
      .map((name) => ({ name, placeholder: USER_PLACEHOLDER })),
  ]
  if (names.length === 0) return undefined
  // Longest first, so `Minis.local` is one host rather than a host and a suffix.
  names.sort((left, right) => right.name.length - left.name.length)
  const kept = [...new Set([...keep, USER_PLACEHOLDER, HOST_PLACEHOLDER])].map(escapeRegExp)
  const pattern = new RegExp(
    `(${[...kept, UUID].join('|')})|(?<![\\p{L}\\p{N}_])(?:${names.map((entry) => `(${escapeRegExp(entry.name)})`).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  )
  return (text) => text.replace(pattern, (match: string, placeholder: string | undefined, ...groups: unknown[]) => {
    if (placeholder !== undefined) return match
    const index = groups.slice(0, names.length).findIndex((group) => group !== undefined)
    return names[index]?.placeholder ?? match
  })
}
