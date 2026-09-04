// The desktop bundle's copy of the packaged executor runtime. The preparation
// itself lives in executor/scripts/prepare-runtime.mjs because the Linux
// `nessie-executor` package installs the identical layout; this script only
// decides where the desktop wants it and which platform-only inputs it needs.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareExecutorRuntime, resolveWindowsPackagedNodeLicense } from '../../executor/scripts/prepare-runtime.mjs'
import { signWindowsArtifacts } from '../../executor/scripts/windows-sign.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '..')
// On Windows owner-only executor state is a DACL that only the native helper
// can write and verify, so the helper ships beside `node.exe` and is pinned by
// the runtime manifest. POSIX hosts prove privacy with ownership and mode bits
// and package no helper, exactly as before.
const windowsNativeHelperPath = async () => {
  const manifestPath = resolve(repositoryDirectory, 'executor/native/Cargo.toml')
  const build = spawnSync(
    'cargo',
    ['build', '--release', '--manifest-path', manifestPath],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) {
    throw new Error('Building the Windows executor native helper failed; the desktop runtime cannot be prepared without it.')
  }
  const helperPath = resolve(repositoryDirectory, 'executor/native/target/release/nessie-executor-native.exe')
  if (!existsSync(helperPath)) {
    throw new Error(`The Windows executor native helper was not produced at ${helperPath}.`)
  }
  // Tauri signs its application and installers, not arbitrary resource
  // executables. Sign this child before prepareExecutorRuntime hashes it so
  // Smart App Control sees a trusted publisher and the manifest pins the exact
  // signed bytes the desktop will launch.
  await signWindowsArtifacts([helperPath])
  return helperPath
}

const windowsRuntimeOptions = process.platform === 'win32'
  ? {
    nativeHelperPath: await windowsNativeHelperPath(),
    nodeLicenseContents: await resolveWindowsPackagedNodeLicense(),
  }
  : {}

await prepareExecutorRuntime({
  entryPoint: resolve(repositoryDirectory, 'executor/src/index.ts'),
  outputDirectory: resolve(desktopDirectory, 'src-tauri/resources/executor-runtime'),
  ...windowsRuntimeOptions,
})
