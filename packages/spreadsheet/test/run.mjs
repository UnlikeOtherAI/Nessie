#!/usr/bin/env node
// The engine talks to fd 1, and that is not survivable on a pipe.
//
// Importing a foreign `.xlsx` and evaluating it prints one `Unexpected type
// (empty) in Sheet!Cell` line per affected cell — 25 000+ for this package's
// own fixture — straight from a Rust thread we do not control. When one of
// those writes fails, the engine panics inside the napi call and the process
// aborts:
//
//   thread '<unnamed>' panicked at library/std/src/io/stdio.rs
//   fatal runtime error: failed to initiate panic, error 5, aborting
//
// No assertion fails; the file simply dies, and CI reports `not ok - test/
// xlsx-fidelity.test.ts` with nothing to explain it. It reproduced on GitHub
// Actions after `--test-concurrency=1` had made it rare locally.
//
// So this runs the suite in ONE process whose stdout is a real FILE, never a
// pipe: `--experimental-test-isolation=none` keeps every test file in the
// runner itself (the admin package already runs this way), and a write to a
// file does not fail the way a write to a pipe does. Running the runner alone
// against a file is not enough — `node --test` spawns a child per file and
// pipes its stdout back, and that pipe is the one the engine dies on, which is
// exactly how the first attempt at this fix still failed in CI.
//
// The file is streamed to our own stdout when the run finishes, so CI still
// shows every TAP line, and the child's exit code is ours.
import { spawn } from 'node:child_process'
import { createReadStream, closeSync, openSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const tapPath = join(tmpdir(), `nessie-spreadsheet-tap-${process.pid}.txt`)
const tapFd = openSync(tapPath, 'w')

const child = spawn(
  process.execPath,
  [
    '--test',
    '--experimental-test-isolation=none',
    '--test-concurrency=1',
    '--import',
    'tsx',
    'test/**/*.test.ts',
  ],
  { stdio: ['ignore', tapFd, 'inherit'] },
)

const code = await new Promise((resolve) => {
  child.on('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 1)))
})

closeSync(tapFd)
await pipeline(createReadStream(tapPath), process.stdout, { end: false })
try {
  unlinkSync(tapPath)
} catch {
  // A leftover temp file is not worth failing a green run over.
}
process.exit(code)
