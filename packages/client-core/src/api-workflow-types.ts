export type AgentTriggerRecord = {
  id: string
  agentId?: string
  workflowInstallationId?: string
  type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
  status: 'active' | 'paused' | 'error' | 'needs_reauthorization'
  enabled: boolean
  name?: string
  description?: string
  config: Record<string, unknown>
  healthReason?: string
  healthDetail?: string
  webhookApiKey?: string
  targetChannelId?: string
  targetThreadId?: string
  lastFiredAt?: string
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WorkflowStepRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked'

export type WorkflowTemplateRecord = {
  id: string
  organizationId: string
  name: string
  description?: string | null
  version: number
  graph: {
    steps: Array<{
      id: string
      input?: Record<string, unknown>
      title?: string
      type: string
    }>
  }
  triggers: unknown
  variableSchema: unknown
  bindingSchema: unknown
  requiredEnvironmentTemplateIds: string[]
  source: 'authored' | 'demonstration'
  /**
   * Server-counted installation totals, present on the list read only.
   * `undefined` means the endpoint did not report them — never "zero".
   */
  installationSummary?: {
    active: number
    total: number
  }
  demonstrationId?: string | null
  adoptedAt?: string | null
  createdByActorType: string
  createdByActorId: string
  createdAt: string
  updatedAt: string
}

export type WorkflowInstallationRecord = {
  id: string
  workflowTemplateId: string
  workflowTemplateVersion: number
  organizationId: string
  channelId?: string | null
  projectId?: string | null
  teamId?: string | null
  status: 'active' | 'paused' | 'draft' | 'disabled'
  active: boolean
  resolvedBindings: Record<string, unknown>
  config: Record<string, unknown>
  createdByActorType: string
  createdByActorId: string
  createdAt: string
  updatedAt: string
}

export type WorkflowRunRecord = {
  id: string
  installationId: string
  organizationId: string
  triggerId?: string | null
  retriedFromWorkflowRunId?: string | null
  originChannelId?: string | null
  originMessageId?: string | null
  originThreadId?: string | null
  replyRootMessageId?: string | null
  status: WorkflowRunStatus
  input: unknown
  output: unknown
  summary?: string | null
  errorMessage?: string | null
  startedByActorType: string
  startedByActorId: string
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type WorkflowStepRunRecord = {
  id: string
  workflowRunId: string
  stepKey: string
  stepType: string
  title: string
  sequence: number
  status: WorkflowStepRunStatus
  input: unknown
  output: unknown
  errorMessage?: string | null
  assignedAgentId?: string | null
  agentRunId?: string | null
  taskId?: string | null
  environmentInstanceId?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type WorkflowRunDetail = {
  run: WorkflowRunRecord
  steps: WorkflowStepRunRecord[]
}

export type WorkflowStepSamplesRecord = {
  templateVersion: number
  workflowInstallationId: string
  workflowRunId: string
  capturedAt: string
  steps: Record<string, unknown>
}

export type AgentTriggerDeliveryRecord = {
  id: string
  triggerId: string
  dedupeKey?: string
  status: 'pending' | 'delivered' | 'failed' | 'skipped'
  source?: string
  payload: unknown
  errorMessage?: string
  runId?: string
  runStatus?: string
  deliveredAt?: string
  createdAt: string
}
