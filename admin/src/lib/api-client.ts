import type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  ApiError,
  ApiResponse,
  MeResponse,
  ToolCallEntry,
} from '@nessie/schemas'

export type AuthProviderDescriptor = {
  autoRedirect: boolean
  enabled: boolean
  label: string
  providerId: string
  type: string
}

export type BootstrapModeResponse = {
  bootstrapMode: true
  bootstrapUrl: '/bootstrap'
}

export type ChannelMetadataRecord = {
  ownerUserId?: string
  systemChannelType?: 'personal_assistant' | string
  [key: string]: unknown
}

export type ChannelRecord = {
  createdAt: string
  defaultThreadId: string
  id: string
  label: string
  metadata?: ChannelMetadataRecord
  organizationId: string
  projectId: string
  projectName: string
  systemChannelType?: 'personal_assistant' | string
  teamId: string
  teamName: string
  type: 'dm' | 'standard'
  unreadCount: number
  updatedAt: string
  visibility: 'private' | 'protected' | 'public'
}

export type ProjectRecord = {
  createdAt: string
  id: string
  memberCount: number
  name: string
  organizationId: string
}

export type TeamRecord = {
  createdAt: string
  id: string
  memberCount: number
  name: string
  projectId: string
}

export type CallParticipantRecord = {
  displayName: string
  joinedAt: string
  leftAt: string | null
  userId: string
}

export type CallRecord = {
  channelId: string
  endedAt: string | null
  id: string
  participants: CallParticipantRecord[]
  roomId: string
  startedAt: string
  startedById: string
  status: 'active' | 'ended'
}

export type AgentRecord = {
  channelIds: string[]
  createdAt: string
  currentRunId?: string
  currentToolName?: string
  currentToolStartedAt?: string
  id: string
  lastActivityAt: string
  model?: string
  name: string
  parentAgentId?: string | null
  provider?: string
  agentKind?: 'shared' | 'personal_assistant'
  delegationMode?: 'none' | 'act_as_requesting_user'
  ownerUserId?: string | null
  role: string
  surfacePolicy?: 'shared' | 'dm_only'
  systemManaged?: boolean
  status: AgentStatusResponse['status']
  systemPrompt?: string
  updatedAt: string
}

export type UserRecord = {
  channelIds: string[]
  createdAt: string
  displayName: string
  email: string
  id: string
  role: string
  updatedAt: string
}

export type MessageReaction = {
  id: string
  messageId: string
  agentId?: string | null
  userId?: string | null
  emoji: string
  createdAt: string
}

export type ThreadMessageRecord = {
  agentId?: string | null
  content: string
  createdAt: string
  id: string
  metadata?: Record<string, unknown>
  reactions?: MessageReaction[]
  role: 'assistant' | 'system' | 'user'
  threadId: string
  userId?: string | null
}

export type ThreadRecord = {
  channelId: string
  createdAt: string
  id: string
  title: string
  updatedAt?: string
}

export type PersonalAssistantInstanceRecord = {
  agentId: string
  channelId: string
  createdAt: string
  id: string
  status: 'active' | 'suspended' | 'archived'
  templateVersion: number
  updatedAt: string
}

export type PersonalAssistantConfigSummary = {
  agentId: string
  model?: string
  provider?: string
  systemPromptPreview?: string
  toolIds: string[]
  updatedAt: string
}

export type PersonalAssistantStateResponse = {
  agent: AgentRecord | null
  channel: ChannelRecord | null
  configSummary?: PersonalAssistantConfigSummary
  instance?: PersonalAssistantInstanceRecord | null
  thread?: ThreadRecord | null
}

export type PersonalAssistantBootstrapResponse = {
  agent: AgentRecord
  channel: ChannelRecord
  configSummary?: PersonalAssistantConfigSummary
  instance?: PersonalAssistantInstanceRecord | null
  thread: ThreadRecord
}

export type ToolDescriptor = {
  builtin?: boolean
  description: string
  enabled?: boolean
  handlerKind?: string
  id: string
  label: string
  safe: boolean
}

export type AgentTriggerRecord = {
  id: string
  agentId?: string
  workflowInstallationId?: string
  type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
  status: 'active' | 'paused' | 'error'
  enabled: boolean
  name?: string
  description?: string
  config: Record<string, unknown>
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

export type AgentTriggerDeliveryRecord = {
  id: string
  triggerId: string
  dedupeKey?: string
  status: 'pending' | 'delivered' | 'failed' | 'skipped'
  source?: string
  payload: unknown
  errorMessage?: string
  runId?: string
  deliveredAt?: string
  createdAt: string
}

export type SessionState =
  | {
      data: BootstrapModeResponse
      kind: 'bootstrap'
    }
  | {
      data: MeResponse
      kind: 'authenticated'
    }

export type ApiClient = {
  delete: <TData>(path: string) => Promise<TData>
  get: <TData>(path: string) => Promise<TData>
  patch: <TData>(path: string, body?: unknown) => Promise<TData>
  post: <TData>(path: string, body?: unknown) => Promise<TData>
  put: <TData>(path: string, body?: unknown) => Promise<TData>
}

export const getBaseUrl = (): string => {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
  return configuredBaseUrl ? configuredBaseUrl.replace(/\/$/, '') : ''
}

const toApiError = async (response: Response): Promise<Error> => {
  const text = await response.text()
  if (!text) {
    return new Error(`${response.status} ${response.statusText}`)
  }

  try {
    const payload = JSON.parse(text) as ApiError
    if (payload.error?.message) {
      return new Error(payload.error.message)
    }
  } catch {
    // Fall through to raw body.
  }

  return new Error(text)
}

export const createApiClient = (token: string | null): ApiClient => {
  const baseUrl = getBaseUrl()

  const request = async <TData>(path: string, init?: RequestInit): Promise<TData> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type') && init?.body) {
      headers.set('content-type', 'application/json')
    }
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      throw await toApiError(response)
    }

    if (response.status === 204) {
      return undefined as TData
    }

    const payload = (await response.json()) as ApiResponse<TData>
    return payload.data
  }

  return {
    delete: (path) => request(path, { method: 'DELETE' }),
    get: (path) => request(path, { method: 'GET' }),
    patch: (path, body) =>
      request(path, {
        method: 'PATCH',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    post: (path, body) =>
      request(path, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    put: (path, body) =>
      request(path, {
        method: 'PUT',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  }
}

export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  MeResponse,
  ToolCallEntry,
}
