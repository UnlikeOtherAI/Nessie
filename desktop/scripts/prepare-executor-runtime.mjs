// The desktop bundle's copy of the packaged executor runtime. The preparation
// itself lives in executor/scripts/prepare-runtime.mjs because the Linux
// `nessie-executor` package installs the identical layout; this script only
// decides where the desktop wants it.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareExecutorRuntime } from '../../executor/scripts/prepare-runtime.mjs'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '..')

await prepareExecutorRuntime({
  entryPoint: resolve(repositoryDirectory, 'executor/src/index.ts'),
  outputDirectory: resolve(desktopDirectory, 'src-tauri/resources/executor-runtime'),
})
