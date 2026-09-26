import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const target = process.argv[2]
if (!['apk', 'aab'].includes(target)) {
  throw new Error('Choose apk for direct install or aab for Google Play')
}

const required = [
  'NESSIE_ANDROID_KEYSTORE_PATH',
  'NESSIE_ANDROID_KEYSTORE_PASSWORD',
  'NESSIE_ANDROID_KEY_ALIAS',
  'NESSIE_ANDROID_KEY_PASSWORD',
]
const missing = required.filter((name) => !process.env[name])
if (missing.length) {
  throw new Error(`Missing Android release signing environment: ${missing.join(', ')}`)
}

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, cwd) => {
  // Windows batch launchers require cmd.exe; these arguments are fixed above.
  const windows = process.platform === 'win32'
  const executable = windows ? 'cmd.exe' : command
  const commandArgs = windows ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

run('pnpm', ['exec', 'expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'], mobileRoot)
run(
  process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
  [target === 'apk' ? 'assembleRelease' : 'bundleRelease', '--no-daemon'],
  path.join(mobileRoot, 'android'),
)
