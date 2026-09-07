export type ExecutionProvider = 'docker' | 'gcloud'
export type ExecutionMode = 'container' | 'function' | 'vm'

export type ProviderProbe = {
  available: boolean
  capabilities: string[]
  metadata: Record<string, unknown>
}

export type ProviderProvisionResult = {
  metadata?: Record<string, unknown>
  providerInstanceRef: string
  status: 'ready' | 'terminated'
}

// What a terminate is allowed to claim. `terminated` means this call reached the
// resource and proved it is gone; `unverified` means it could not, and therefore
// knows nothing about whether the machine is still running.
//
// The distinction exists because a `docker` reference is a container id on ONE
// host's daemon while queue jobs are not host-routed, so a terminate claimed by
// any other replica gets `No such container` from a daemon that never had it
// (audit 6.3/8.2, `docs/standards/horizontal-scaling/storage-and-realtime.md` invariant 7). Swallowing
// that as already-gone let `persistTermination` write `terminated` for a
// container still running on the original host. A provider that cannot prove the
// resource is gone says so here, and the row records the honest state instead.
export type ProviderTerminationResult = {
  metadata: Record<string, unknown>
  outcome: 'terminated' | 'unverified'
}

export type ProvisioningContext = {
  instance: {
    agentId: string | null
    channelId: string | null
    id: string
    launchConfig: unknown
    launchedByActorId: string
    launchedByActorType: string
    metadata: unknown
    organizationId: string
    projectId: string | null
    providerInstanceRef: string | null
    runId: string | null
    startedAt: Date | null
    status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
    teamId: string | null
    workflowRunId: string | null
    workflowStepRunId: string | null
    template: {
      id: string
      image: string | null
      launchConfig: unknown
      mode: ExecutionMode
      pricingConfig: unknown
      provider: ExecutionProvider
    }
  }
  leaseId: string
  runnerId: string
}

export type TerminationContext = {
  instance: {
    agentId: string | null
    channelId: string | null
    errorMessage: string | null
    id: string
    launchConfig: unknown
    launchedByActorId: string
    launchedByActorType: string
    metadata: unknown
    organizationId: string
    projectId: string | null
    providerInstanceRef: string | null
    readyAt: Date | null
    runId: string | null
    startedAt: Date | null
    status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
    teamId: string | null
    terminatedAt: Date | null
    workflowRunId: string | null
    workflowStepRunId: string | null
    template: {
      id: string
      image: string | null
      launchConfig: unknown
      mode: ExecutionMode
      pricingConfig: unknown
      provider: ExecutionProvider
    }
  }
}

export type WorkflowLinkedInstance = Pick<
  ProvisioningContext['instance'],
  | 'agentId'
  | 'channelId'
  | 'id'
  | 'launchedByActorId'
  | 'launchedByActorType'
  | 'organizationId'
  | 'projectId'
  | 'runId'
  | 'teamId'
  | 'workflowRunId'
  | 'workflowStepRunId'
>

export type WorkflowInstanceState = WorkflowLinkedInstance & {
  errorMessage: string | null
  metadata: unknown
  providerInstanceRef: string | null
  status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
}
