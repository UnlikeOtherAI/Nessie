import assert from 'node:assert/strict'
import test from 'node:test'

// The provider chokepoint resolves the mode from configuration, and
// `loadConfig` itself refuses `filesystem` storage outside `local`, so a
// non-local mode has to name an object store the same way production does. Set
// before the import: node --test gives each test file its own process, so this
// cannot leak, and the mode is resolved once and cached from the first call.
process.env['NESSIE_MODE'] = 'selfHosted'
process.env['NESSIE_STORAGE_PROVIDER'] = 's3'
process.env['NESSIE_STORAGE_BUCKET'] = 'nessie'

const ABSENT_CONTAINER = 'container-on-another-host'

const { probeProvider, provisionProviderInstance, terminateProviderInstance } = await import('./providers.js')

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
  // Carried on the termination context since a reclaim must be able to read why
  // a failed provision failed; `persistTermination` no longer nulls it.
  errorMessage: null,
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

const dockerRunner = (absentContainer?: string) => {
  const calls: Array<{ args: string[]; command: string }> = []
  const run = async (command: string, args: string[]) => {
    calls.push({ args, command })
    if (args.includes(absentContainer ?? '')) {
      throw new Error(`No such container: ${absentContainer}`)
    }
    return { stderr: '', stdout: '' }
  }
  return { calls, run }
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
  const runner = dockerRunner()
  const termination = await terminateProviderInstance({ instance }, { commandRunner: runner.run })

  assert.deepEqual(termination, {
    metadata: { containerId: 'container-1', terminatedBy: 'docker' },
    outcome: 'terminated',
  })
  assert.deepEqual(runner.calls, [{ args: ['rm', '-f', 'container-1'], command: 'docker' }])
})

// Plan row 5.12. `docker rm -f` reaches THIS worker's daemon, and outside
// `local` the container it was asked about belongs to whichever host provisioned
// it — queue jobs are not host-routed. A daemon that never held the container
// answers `No such container`, which used to be swallowed as already-gone and
// persisted as `terminated`: a row saying a container is gone while it runs on
// and bills. The provider now reports what it actually knows, which is nothing.
test('a docker terminate outside local that cannot find the container is unverified', async () => {
  const runner = dockerRunner(ABSENT_CONTAINER)
  const termination = await terminateProviderInstance({
    instance: { ...instance, providerInstanceRef: ABSENT_CONTAINER },
  }, { commandRunner: runner.run })

  assert.equal(termination.outcome, 'unverified')
  assert.equal(termination.metadata['containerId'], ABSENT_CONTAINER)
  assert.equal(termination.metadata['terminateUnverifiedReason'], 'DOCKER_NO_SUCH_CONTAINER')
  assert.deepEqual(runner.calls, [{ args: ['rm', '-f', ABSENT_CONTAINER], command: 'docker' }])
})
