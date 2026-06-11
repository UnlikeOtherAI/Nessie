import { createApiClient as createCoreApiClient, type ApiClient } from '@nessie/client-core'

export type { ApiClient }

// Admin (Vite) resolves the API base URL from build-time env. This is the
// single web-specific seam; @nessie/client-core stays env-agnostic and has the
// base URL injected by the host (here).
export const getBaseUrl = (): string => {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
  return configuredBaseUrl ? configuredBaseUrl.replace(/\/$/, '') : ''
}

export const createApiClient = (token: string | null): ApiClient =>
  createCoreApiClient({ baseUrl: getBaseUrl(), token })

// Re-export the shared API data-shape + schema types so existing
// `import { ... } from '../lib/api-client'` call sites keep working.
export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentRecord,
  AgentStatusResponse,
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AuthProviderDescriptor,
  BootstrapModeResponse,
  CallParticipantRecord,
  CallRecord,
  ChannelMetadataRecord,
  ChannelRecord,
  CreateFeedbackRequest,
  FeedbackRecord,
  MeResponse,
  MessageReaction,
  MessageSearchResult,
  OrganizationSummary,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantConfigSummary,
  PersonalAssistantInstanceRecord,
  PersonalAssistantStateResponse,
  ProjectMemberRecord,
  ProjectRecord,
  SessionState,
  TeamRecord,
  ThreadMessageRecord,
  ThreadRecord,
  ToolCallEntry,
  ToolDescriptor,
  UserActiveStatus,
  UserRecord,
  UserStatusRecord,
  UserStatusRuleRecord,
  UserStatusRuleScope,
  UserStatusScheduleKind,
  UserStatusScheduleRecord,
  WorkflowInstallationRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRunRecord,
  WorkflowStepRunStatus,
  WorkflowTemplateRecord,
} from '@nessie/client-core'
