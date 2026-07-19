import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const installerSource = new URL(
  '../../infrastructure/compose/set-ledger-app-key.sh',
  import.meta.url,
)
const billingInstallerSource = new URL(
  '../../infrastructure/compose/set-ledger-billing-reader-key.sh',
  import.meta.url,
)
const deepSignalInstallerSource = new URL(
  '../../infrastructure/compose/set-deepsignal-app-key.sh',
  import.meta.url,
)
const workflowSource = new URL(
  '../../.github/workflows/deploy.yml',
  import.meta.url,
)

const appKey = `lk_${'n'.repeat(32)}`
const deepSignalAppKey = `dsk_${'s'.repeat(32)}`

const makeInstallerFixture = (
  initialEnv = '',
  source = installerSource,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'nessie-ledger-key-'))
  const installer = join(directory, 'set-ledger-app-key.sh')
  const envFile = join(directory, '.env')
  cpSync(source, installer)
  execFileSync('chmod', ['700', installer])
  if (initialEnv) {
    execFileSync('bash', ['-c', 'umask 077; printf %s \"$1\" > .env', '_', initialEnv], {
      cwd: directory,
    })
  }
  return { directory, envFile, installer }
}

const runInstaller = (installer: string, appKeyInput: string) =>
  spawnSync('bash', [installer], {
    encoding: 'utf8',
    input: `${appKeyInput}\n`,
  })

test('Ledger installer atomically pins both Nessie routes to its app key', () => {
  const fixture = makeInstallerFixture([
    'PRESERVE_ME=yes',
    'LEDGER_PROXY_TOKEN=lk_obsolete_proxy_key_value',
    'NESSIE_MODEL_API_KEY=lk_obsolete_model_key_value',
    '',
  ].join('\n'))

  const result = runInstaller(fixture.installer, appKey)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(fixture.envFile, 'utf8'),
    [
      'PRESERVE_ME=yes',
      `LEDGER_PROXY_TOKEN=${appKey}`,
      `NESSIE_MODEL_API_KEY=${appKey}`,
      '',
    ].join('\n'),
  )
  assert.equal(statSync(fixture.envFile).mode & 0o777, 0o600)
})

test('Ledger installer rejects malformed or cross-principal key reuse', () => {
  const malformed = makeInstallerFixture()
  const malformedResult = runInstaller(malformed.installer, 'not-a-ledger-key')
  assert.notEqual(malformedResult.status, 0)
  assert.doesNotMatch(malformedResult.stderr, /not-a-ledger-key/u)

  const reusedValues = [
    {
      env: `LEDGER_BILLING_READ_APP_KEY_NESSIE=${appKey}`,
      name: 'LEDGER_BILLING_READ_APP_KEY_NESSIE',
    },
    {
      env: `DEEPSIGNAL_MCP_APP_KEY='${appKey}'\n`,
      name: 'DEEPSIGNAL_MCP_APP_KEY',
    },
    {
      env: `UOA_CLIENT_SECRET="${appKey}"\n`,
      name: 'UOA_CLIENT_SECRET',
    },
    {
      env: `LEDGER_BILLING_READ_APP_KEY_NESSIE=${appKey} # reader\n`,
      name: 'LEDGER_BILLING_READ_APP_KEY_NESSIE',
    },
    {
      env: `DEEPSIGNAL_MCP_APP_KEY='${appKey}' # connector\n`,
      name: 'DEEPSIGNAL_MCP_APP_KEY',
    },
  ]

  for (const reusedValue of reusedValues) {
    const reused = makeInstallerFixture(reusedValue.env)
    const reusedResult = runInstaller(reused.installer, appKey)
    assert.notEqual(reusedResult.status, 0)
    assert.match(reusedResult.stderr, new RegExp(reusedValue.name, 'u'))
    assert.doesNotMatch(reusedResult.stderr, new RegExp(appKey, 'u'))
  }
})

test('credential installers preserve an unterminated unrelated setting', () => {
  const cases = [
    {
      source: installerSource,
      key: appKey,
      expected: [
        'PRESERVE_ME=yes',
        `LEDGER_PROXY_TOKEN=${appKey}`,
        `NESSIE_MODEL_API_KEY=${appKey}`,
        '',
      ].join('\n'),
    },
    {
      source: billingInstallerSource,
      key: appKey,
      expected: [
        'PRESERVE_ME=yes',
        `LEDGER_BILLING_READ_APP_KEY_NESSIE=${appKey}`,
        '',
      ].join('\n'),
    },
    {
      source: deepSignalInstallerSource,
      key: deepSignalAppKey,
      expected: [
        'PRESERVE_ME=yes',
        `DEEPSIGNAL_MCP_APP_KEY=${deepSignalAppKey}`,
        '',
      ].join('\n'),
    },
  ]

  for (const installerCase of cases) {
    const fixture = makeInstallerFixture(
      'PRESERVE_ME=yes',
      installerCase.source,
    )
    const result = runInstaller(fixture.installer, installerCase.key)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(fixture.envFile, 'utf8'),
      installerCase.expected,
    )
  }
})

test('deployment supplies the dedicated Nessie Ledger key over SSH stdin', () => {
  const workflow = readFileSync(workflowSource, 'utf8')
  assert.match(
    workflow,
    /LEDGER_PROXY_TOKEN: \$\{\{ secrets\.LEDGER_PROXY_TOKEN \}\}/u,
  )
  assert.match(
    workflow,
    /bash infrastructure\/compose\/set-ledger-app-key\.sh/u,
  )
})
