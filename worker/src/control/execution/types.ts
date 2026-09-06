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
