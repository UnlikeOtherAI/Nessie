// Starts the isolated TLS GreenMail fixture for the deterministic mail workflow.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const fixtureDirectory = resolve(root, '.nessie/mail-agent-e2e')
const certificate = resolve(fixtureDirectory, 'greenmail.p12')
const certificatePem = resolve(fixtureDirectory, 'greenmail.pem')
const compose = resolve(root, 'infrastructure/compose/docker-compose.mail-agent-e2e.yml')
const container = 'nessie-mail-agent-e2e-greenmail-1'
const certificatePassword = 'mail-e2e-cert'
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL must name a dedicated migrated database.')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

let childStatus = 1
try {
  mkdirSync(fixtureDirectory, { recursive: true })
  if (!existsSync(certificate)) {
    run('docker', [
    'run', '--rm', '--entrypoint', 'keytool', '-v', `${fixtureDirectory}:/certs`,
    'greenmail/standalone:2.1.3', '-genkeypair', '-alias', 'greenmail', '-keyalg', 'RSA',
    '-keysize', '2048', '-validity', '30', '-dname', 'CN=mail.nessie.test',
    '-ext', 'SAN=dns:mail.nessie.test', '-storetype', 'PKCS12', '-keystore', '/certs/greenmail.p12',
    '-storepass', certificatePassword, '-keypass', certificatePassword, '-noprompt',
    ])
  }
  run('docker', ['compose', '-f', compose, 'up', '-d'])
  const pem = run('docker', [
  'exec', container, 'keytool', '-exportcert', '-rfc', '-alias', 'greenmail',
  '-keystore', '/certs/greenmail.p12', '-storetype', 'PKCS12', '-storepass', certificatePassword,
  ])
  writeFileSync(certificatePem, pem)

  const child = spawnSync(process.execPath, [
  '--experimental-test-module-mocks', '--import', 'tsx',
  resolve(root, 'worker/test-harness/mail-agent-e2e-child.ts'),
  ], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NESSIE_AUTH_SECRET: process.env.NESSIE_AUTH_SECRET ?? 'mail-agent-e2e-secret-only',
    NESSIE_DB_URL: databaseUrl,
    NESSIE_MODEL_API_KEY: 'local-mail-e2e',
    NESSIE_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    NESSIE_MODEL_NAME: 'gemma4:latest',
    NESSIE_MODEL_PROVIDER: 'openai',
    NESSIE_MODEL_MAX_TOKENS: '512',
    NESSIE_MODEL_TEMPERATURE: '0',
    NESSIE_MAIL_E2E_MODE: process.env.NESSIE_MAIL_E2E_MODE ?? 'mock',
    NODE_EXTRA_CA_CERTS: certificatePem,
    OPENAI_API_KEY: 'local-mail-e2e',
  },
  stdio: 'inherit',
  })
  childStatus = child.status ?? 1
} finally {
  // This Compose project and certificate directory are uniquely named for this
  // harness. Never touch the separately-managed local wire fixture.
  spawnSync('docker', ['compose', '-f', compose, 'down', '--volumes'], { cwd: root, stdio: 'inherit' })
  rmSync(fixtureDirectory, { force: true, recursive: true })
}
process.exitCode = childStatus
