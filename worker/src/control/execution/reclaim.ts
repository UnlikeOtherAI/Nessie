import { randomUUID } from 'node:crypto'
import { type Prisma } from '@prisma/client'
import { enqueueQueueJob } from '../../queue.js'
import type { ExecutionProvider } from './types.js'

// One way to ask for an abandoned machine to be reclaimed, shared by the two
// places that discover one: the lease sweep (`expireExecutionLeases`, a
// runner that stopped renewing) and the provisioning failure path
// (`markProvisionFailure`, a provider that threw after it had already created
// something). Both mean the same thing — this instance row is terminal and the
// machine it names has nobody left driving it — so both must make the same
// decision about whether reclaiming is even possible, and neither may grow its
// own private terminate.
//
// A reference is only reclaimable from an arbitrary replica when it is a global
// address. `gcloud` refs are `gcloud:<kind>:<project>:<zone|region>:<name>`, so
// whichever replica claims `execution.environment.terminate` deletes the real
// VM or Cloud Run job. A `docker` ref is a container on ONE host's daemon
// (horizontal-scaling audit 8.2; `docs/standards/horizontal-scaling.md`
// invariant 7), and queue jobs are not host-routed: a terminate claimed by
// another replica would run `docker rm -f` against the wrong daemon, get
// `No such container`, have `terminateDocker` swallow it as already-gone, and
// let `persistTermination` write `terminated` — a lie about a container that is
// still running and still consuming the dead host's CPU.
//
// So docker gets no terminate, and nothing automatic reclaims an abandoned
// container: the instance keeps its honest terminal state and the container is
// found on the runner's own host by the `nessie.instance-id` label
// `buildDockerContainerName`/`buildSystemLabels` put on it, with the host named
// by `runnerLabel` in the instance metadata. `loadProvisioningContext` makes the
// mirror refusal on the way in with `EXECUTION_RUNNER_NOT_LOCAL`.
//
// This is a guard, not a branch that fires today: docker never carries a
// reference while a non-terminal lease exists, because it derives nothing before
// provisioning and `persistProvisionSuccess` writes its container id in the same
// transaction that completes the lease. It stays because it is the enforcement
// point for the invariant above — the day a host-local provider does start
// naming its resource early, this is what keeps the sweep from reporting a
// reclaim it cannot perform.
const HOST_INDEPENDENT_PROVIDERS: readonly ExecutionProvider[] = ['gcloud']

// Namespaced apart from the API's `execution-environment:terminate:<id>` so a
// user-requested termination that already ran cannot suppress a reclaim, and
// apart from each other so the sweep and the failure path do not suppress one
// another either. Within one reason the key repeats the guarantee across passes.
const RECLAIM_REASONS = {
  'lease-expired': {
    correlationPrefix: 'execution-lease-expiry',
    purpose: 'execution.lease.expiry',
  },
  'provision-failed': {
    correlationPrefix: 'execution-provision-failure',
    purpose: 'execution.provision.failure',
  },
} as const

export type ReclaimReason = keyof typeof RECLAIM_REASONS

// The terminate is the reclaimer's own act, not a replay of whoever launched the
// instance: attributing it to the launcher would put a request in the audit
// trail that person never made, and `launchedByActorType` can be `system`,
// which `AuthorizedActionContextSchema` does not accept.
const buildReclaimActorContext = (input: {
  instanceId: string
  organizationId: string
  reason: ReclaimReason
}) => ({
  actionContext: {
    correlationId: `${RECLAIM_REASONS[input.reason].correlationPrefix}:${input.instanceId}`,
    purpose: RECLAIM_REASONS[input.reason].purpose,
    requestId: randomUUID(),
  },
  actor: {
    actorId: 'execution-lease-sweep',
    actorType: 'service' as const,
    roles: ['system'],
  },
  tenant: {
    organizationId: input.organizationId,
  },
})

// Enqueue the terminate for a machine nothing is driving any more. Returns
// false — without enqueuing — when there is nothing to address (no reference)
// or when the reference is not reclaimable from an arbitrary replica.
//
// Call it inside the transaction that made the instance terminal, so only the
// writer that actually won that claim asks for the reclaim.
export const enqueueAbandonedMachineTermination = async (
  tx: Prisma.TransactionClient,
  input: {
    instanceId: string
    organizationId: string
    provider: ExecutionProvider
    providerInstanceRef: string | null
    reason: ReclaimReason
  },
): Promise<boolean> => {
  if (!input.providerInstanceRef || !HOST_INDEPENDENT_PROVIDERS.includes(input.provider)) {
    return false
  }

  return enqueueQueueJob(tx, {
    idempotencyKey: `execution-environment:terminate:${input.reason}:${input.instanceId}`,
    payload: {
      actorContext: buildReclaimActorContext({
        instanceId: input.instanceId,
        organizationId: input.organizationId,
        reason: input.reason,
      }),
      instanceId: input.instanceId,
    },
    topic: 'execution.environment.terminate',
  })
}
