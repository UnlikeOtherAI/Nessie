import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { packagedNativeHelperPath } from '../src/state-security.js'

/**
 * What a Windows run of this suite has, and the stated reason a test that needs
 * more skips there instead of failing — or, for one that waits on a guest start
 * a refused state save never reaches, hanging the whole run. Each is `false` on
 * Linux and macOS, so nothing here changes what runs in CI.
 *
 * Executor state on Windows is owner-only through a DACL, which only the
 * packaged native helper sets and reads (`state-security.ts`): it runs for a
 * packaged runtime — `NESSIE_EXECUTOR_PACKAGED_CLI=1`, with
 * `nessie-executor-native.exe` beside the Node running the process — and a
 * development Node has neither. Those tests run on Windows the way
 * desktop-windows.yml runs `control-plane-e2e.test.ts`: under the installed
 * package's `node.exe`, or a copy of `node.exe` placed beside a helper built
 * with `cargo build --release` in `executor/native`, with the marker set.
 */
const packagedRuntime = process.platform === 'win32'
  && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
  && existsSync(packagedNativeHelperPath())

export const WINDOWS_STATE_HELPER_SKIP: string | false = process.platform === 'win32' && !packagedRuntime
  ? 'Windows executor state needs the packaged native helper beside node.exe and NESSIE_EXECUTOR_PACKAGED_CLI=1 (test/windows-prerequisites.ts).'
  : false

/**
 * Windows verifies guest VM artifacts against the installed package's own
 * resources (`resources/guest/…` beside its `node.exe`), which a helper built
 * on its own does not bring.
 */
export const WINDOWS_GUEST_RESOURCES_SKIP: string | false = process.platform === 'win32'
  && !(packagedRuntime && existsSync(join(dirname(process.execPath), 'resources', 'guest', 'build-initrd.exe')))
  ? 'Windows guest VM artifacts are verified against the installed executor package, whose node.exe must run this test.'
  : false

const canCreateSymlinks = (): boolean => {
  const directory = mkdtempSync(join(tmpdir(), 'nessie-symlink-probe-'))
  try {
    writeFileSync(join(directory, 'target'), '')
    symlinkSync(join(directory, 'target'), join(directory, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

/** A file symlink on Windows needs Developer Mode or an elevated token. */
export const WINDOWS_SYMLINK_SKIP: string | false = process.platform === 'win32' && !canCreateSymlinks()
  ? 'Creating a symbolic link on Windows needs Developer Mode or an elevated token, which this process lacks.'
  : false
