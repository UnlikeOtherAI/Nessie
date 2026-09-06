import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGcloudInstanceName } from '../src/control/execution/naming.js'
import { deriveProviderInstanceRef } from '../src/control/execution/providers.js'
import type { ExecutionMode, ExecutionProvider, ProvisioningContext } from '../src/control/execution/types.js'

// `allocateExecutionEnvironmentInstance` writes this reference onto the
// instance row *before* it calls the provider, so that a worker killed
// mid-provision still leaves the lease sweep something to terminate. That is
// only sound while the derived string is the one the provision itself would
// produce — which is why `resolveGcloudVmTarget` /
// `resolveGcloudFunctionTarget` are the single source of both, and why the
// cases below pin the format and the fallback name.

const INSTANCE_ID = '3f1a5b7c-9d2e-4f60-8a13-c5e7d9b1f204'

const contextFor = (input: {
  launchConfig?: Record<string, unknown>
  mode: ExecutionMode
  provider: ExecutionProvider
}): ProvisioningContext => ({
  instance: {
    agentId: null,
    channelId: null,
    id: INSTANCE_ID,
    launchConfig: input.launchConfig ?? {},
    launchedByActorId: 'actor',
    launchedByActorType: 'user',
    metadata: {},
    organizationId: 'org',
    projectId: null,
    providerInstanceRef: null,
    runId: null,
    startedAt: null,
    status: 'provisioning',
    teamId: null,
    workflowRunId: null,
    workflowStepRunId: null,
    template: {
      id: 'template',
      image: 'debian-12',
      launchConfig: {},
      mode: input.mode,
      pricingConfig: {},
      provider: input.provider,
    },
  },
  leaseId: 'lease',
  runnerId: 'runner',
})

test('a gcloud VM reference is derivable before the VM exists', () => {
  const ref = deriveProviderInstanceRef(
    contextFor({
      launchConfig: { projectId: 'nessie-prod', zone: 'europe-west4-a' },
      mode: 'vm',
      provider: 'gcloud',
    }),
  )

  assert.equal(ref, `gcloud:vm:nessie-prod:europe-west4-a:${buildGcloudInstanceName(INSTANCE_ID)}`)
})

test('an explicit instanceName is what the derivation uses, as the provision would', () => {
  const ref = deriveProviderInstanceRef(
    contextFor({
      launchConfig: { instanceName: 'pinned-name', projectId: 'nessie-prod', zone: 'europe-west4-a' },
      mode: 'vm',
      provider: 'gcloud',
    }),
  )

  assert.equal(ref, 'gcloud:vm:nessie-prod:europe-west4-a:pinned-name')
})

test('a Cloud Run job reference is derivable before the job is deployed', () => {
  const ref = deriveProviderInstanceRef(
    contextFor({
      launchConfig: { image: 'gcr.io/p/i', projectId: 'nessie-prod', region: 'europe-west4' },
      mode: 'function',
      provider: 'gcloud',
    }),
  )

  assert.equal(
    ref,
    `gcloud:function:nessie-prod:europe-west4:${buildGcloudInstanceName(INSTANCE_ID)}`,
  )
})

// Docker's reference is the container id `docker run` prints, which does not
// exist until the container does. Deriving one is impossible, so the pre-provision
// write is a no-op and a docker instance abandoned mid-provision keeps the
// honest `EXECUTION_LEASE_EXPIRED` the sweep gives an instance with no
// reference — never a terminate job routed at some other host's daemon.
test('a docker instance derives nothing, because its reference is the container id', () => {
  assert.equal(
    deriveProviderInstanceRef(
      contextFor({
        launchConfig: { image: 'debian-12' },
        mode: 'container',
        provider: 'docker',
      }),
    ),
    null,
  )
})

// An incomplete launch config must not throw here: the provision that follows
// raises `GCLOUD_VM_PROJECT_AND_ZONE_REQUIRED` over the same fields, and
// `markProvisionFailure` is the path that should report it.
test('an incomplete gcloud launch config derives nothing rather than throwing', () => {
  assert.equal(
    deriveProviderInstanceRef(
      contextFor({ launchConfig: { projectId: 'nessie-prod' }, mode: 'vm', provider: 'gcloud' }),
    ),
    null,
  )
  assert.equal(
    deriveProviderInstanceRef(
      contextFor({ launchConfig: { projectId: 'nessie-prod' }, mode: 'function', provider: 'gcloud' }),
    ),
    null,
  )
})
