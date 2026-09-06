import assert from 'node:assert/strict'
import test from 'node:test'

// The provider chokepoint reads `loadConfig()` at call time, and `loadConfig`
// itself refuses `filesystem` storage outside `local`, so a non-local mode has
// to name an object store the same way production does. Set before the import:
// node --test gives each test file its own process, so this cannot leak.
process.env['NESSIE_MODE'] = 'selfHosted'
process.env['NESSIE_STORAGE_PROVIDER'] = 's3'
process.env['NESSIE_STORAGE_BUCKET'] = 'nessie'

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

test('terminating a docker environment outside local is refused rather than recorded', async () => {
  // The defect this closes: terminate swallowed "No such container" and wrote
  // `terminated` while the container on another host kept running.
  const error = await refusalFrom(() => terminateProviderInstance({ instance }))

  assert.equal(error.name, 'SingleInstanceCapabilityError')
  assert.match(error.message, /cannot be inspected or terminated from another/)
})
