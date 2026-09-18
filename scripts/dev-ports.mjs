// The one place that decides which ports a local dev instance binds.
//
// 5454/5455 used to be written into the API config default, the Vite server
// block, the `predev` guard and every browser harness separately, and the
// standard called them non-negotiable. That was true of a single checkout and
// false of this repo's actual workflow: work happens in parallel worktrees, and
// a second one could not bring up its own API and admin at all — so a change
// was either verified against another checkout's running server, which proves
// nothing, or not verified in the app.
//
// Resolution order per port (first wins):
//   1. the environment (`NESSIE_API_PORT` / `NESSIE_ADMIN_PORT`)
//   2. a `KEY=VALUE` line in the repo root `.env`, which is also the file
//      `api`'s dev script loads, so one file moves a whole worktree
//   3. the documented defaults below
//
// Every consumer reads it from here rather than re-deriving it, because a
// resolver that disagrees with itself puts the admin's proxy on one API and
// the browser on another — a failure that looks like broken code.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_API_PORT = 5454
export const DEFAULT_ADMIN_PORT = 5455

export const API_PORT_ENV = 'NESSIE_API_PORT'
export const ADMIN_PORT_ENV = 'NESSIE_ADMIN_PORT'

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const ROOT_ENV_PATH = path.join(REPO_ROOT, '.env')

/** A `KEY=VALUE` read of a dotenv file. Absent or unreadable reads as unset. */
export const readEnvFileValue = (key, filePath = ROOT_ENV_PATH) => {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== key) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    return value || null
  }
  return null
}

/**
 * A port number, or a thrown error naming the variable that is wrong. Invalid
 * is never silently replaced by the default: a typo'd port that quietly falls
 * back binds the number somebody else's worktree is already on.
 */
export const parsePort = (raw, source) => {
  const port = Number(String(raw).trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a port number between 1 and 65535, got "${raw}"`)
  }
  return port
}

const resolve = (key, fallback, env, envFilePath) => {
  const fromEnv = env[key]?.trim()
  if (fromEnv) return parsePort(fromEnv, key)
  const fromFile = readEnvFileValue(key, envFilePath)
  if (fromFile) return parsePort(fromFile, `${key} in ${envFilePath}`)
  return fallback
}

export const resolveApiPort = (env = process.env, envFilePath = ROOT_ENV_PATH) =>
  resolve(API_PORT_ENV, DEFAULT_API_PORT, env, envFilePath)

export const resolveAdminPort = (env = process.env, envFilePath = ROOT_ENV_PATH) =>
  resolve(ADMIN_PORT_ENV, DEFAULT_ADMIN_PORT, env, envFilePath)

export const resolveDevPorts = (env = process.env, envFilePath = ROOT_ENV_PATH) => ({
  admin: resolveAdminPort(env, envFilePath),
  api: resolveApiPort(env, envFilePath),
})
