// The menu bar app's copy of the packaged executor runtime.
//
// The preparation itself lives in executor/scripts/prepare-runtime.mjs because
// the Linux `nessie-executor` package, the desktop bundle and this app install
// the identical layout; this script only decides where the app bundle wants it.
// macOS packages no native helper: the Windows DACL helper has no counterpart
// here, since POSIX hosts prove owner-only state with ownership and mode bits.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(appDirectory, '../..')

const outputDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(appDirectory, 'build/executor-runtime')

const prepared = await prepareExecutorRuntime({
  entryPoint: resolve(repositoryDirectory, 'executor/src/index.ts'),
  outputDirectory,
})

// The build script copies this directory into the app bundle's Resources, so the
// last line is the path it reads.
process.stdout.write(`${prepared.runtimeDirectory}\n`)
