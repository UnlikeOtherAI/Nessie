import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The provider chokepoint resolves the mode from configuration, and
// `loadConfig` itself refuses `filesystem` storage outside `local`, so a
// non-local mode has to name an object store the same way production does. Set
// before the import: node --test gives each test file its own process, so this
// cannot leak, and the mode is resolved once and cached from the first call.
process.env['NESSIE_MODE'] = 'selfHosted'
process.env['NESSIE_STORAGE_PROVIDER'] = 's3'
process.env['NESSIE_STORAGE_BUCKET'] = 'nessie'

// A `docker` on PATH that records its arguments and does nothing else. The
// terminate case below has to prove the call reaches the daemon rather than
// being turned away at the gate, and it must prove that on a machine with no
// Docker installed as readily as on one with containers running.
const shimDirectory = mkdtempSync(`${tmpdir()}/nessie-docker-shim-`)
const invocations = join(shimDirectory, 'invocations')
writeFileSync(
  join(shimDirectory, 'docker'),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(invocations)}\n`,
)
chmodSync(join(shimDirectory, 'docker'), 0o755)
process.env['PATH'] = `${shimDirectory}:${process.env['PATH'] ?? ''}`

const { probeProvider, provisionProviderInstance, terminateProviderInstance } =
  await import('./providers.js')

const dockerTemplate = {
  id: 'template-1',
  image: 'alpine:3',
  launchConfig: {},
  mode: 'container' as const,
  pricingConfig: {},
  provider: 'docker' as const,
}

const instance = {
  agentId: null,
  channelId: null,
  id: 'instance-1',
  launchConfig: {},
  launchedByActorId: 'actor-1',
  launchedByActorType: 'user',
  metadata: {},
  organizationId: 'org-1',
  projectId: null,
  providerInstanceRef: 'container-1',
  readyAt: null,
  runId: null,
  startedAt: null,
  status: 'ready' as const,
  teamId: null,
  terminatedAt: null,
  template: dockerTemplate,
  workflowRunId: null,
  workflowStepRunId: null,
}

const refusalFrom = async (fn: () => Promise<unknown>): Promise<Error> => {
  try {
    await fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a refusal; the call succeeded')
}

test('probing docker outside local reports offline with the reason, without shelling out', async () => {
  const probe = await probeProvider('docker')

  assert.equal(probe.available, false)
  assert.match(String(probe.metadata['error']), /`docker` execution environment provider/)
  assert.match(String(probe.metadata['error']), /not allowed in selfHosted mode/)
})

test('provisioning a docker environment outside local is refused, naming gcloud', async () => {
  const error = await refusalFrom(() =>
    provisionProviderInstance({
      instance: { ...instance, template: dockerTemplate },
      leaseId: 'lease-1',
      runnerId: 'runner-1',
    }))

  assert.equal(error.name, 'SingleInstanceCapabilityError')
  assert.match(error.message, /not allowed in selfHosted mode/)
  assert.match(error.message, /provider `gcloud`/)
})

test('terminating an existing docker environment outside local still runs', async () => {
  // The asymmetry the gate is built on: creating a new single-host resource is
  // refused, cleaning up one that already exists never is. A self-hosted
  // operator who mounted the Docker socket into the worker before upgrading has
  // live containers; if this threw, the terminate job would be claimed, the
  // assertion would fire, and every one of those containers would keep running
  // with its row stuck in `terminating` forever.
  const metadata = await terminateProviderInstance({ instance })

  assert.deepEqual(metadata, { containerId: 'container-1', terminatedBy: 'docker' })
  assert.equal(readFileSync(invocations, 'utf8').trim(), 'rm -f container-1')
})
