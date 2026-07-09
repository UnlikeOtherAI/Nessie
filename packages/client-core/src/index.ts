// HTTP client + shared API types.
export {
  createApiClient,
  type ApiClient,
  type ApiClientConfig,
} from './api-client.js'

// Shared API data-shape types (also re-exported via api-client for back-compat).
export type {
  AgentRecord,
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AuthProviderDescriptor,
  BootstrapModeResponse,
  CallParticipantRecord,
  CallRecord,
  ChannelMetadataRecord,
  ChannelRecord,
  FavoriteRecord,
  FavoriteTargetType,
  MessageReaction,
  MessageSearchResult,
  PresenceEntry,
  PresenceListResponse,
  PresenceManualState,
  PresenceState,
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
} from './api-types.js'

// Schema-sourced types previously surfaced from the admin api-client module.
export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  CreateFeedbackRequest,
  FeedbackRecord,
  IntegratedProductAuthMode,
  IntegratedProductCategory,
  IntegratedProductHealthStatus,
  IntegratedProductInstallState,
  IntegratedProductResponse,
  IntegrationPluginAvailability,
  IntegrationPluginInstallMode,
  IntegrationPluginManifest,
  IntegrationPluginPrivacyTier,
  IntegrationPluginSurfaceStatus,
  IntegrationUiCard,
  IntegrationUiCardAction,
  IntegrationUiCardField,
  IntegrationUiCardStatus,
  MeResponse,
  OrganizationSummary,
  ProductAccountLinkRecord,
  ProductAccountLinkStatus,
  ProductMcpInstallationRecord,
  ProductTeamEnablementRecord,
  ProductUsageSummaryRecord,
  SetProductTeamEnablementRequest,
  ToolCallEntry,
  UpdateOrganizationLogoRequest,
} from '@nessie/schemas'

// React context + hook for the API client.
export {
  ApiClientProvider,
  useApiClient,
  type ApiClientProviderProps,
} from './ApiClientProvider.js'

// TanStack Query provider + client factory.
export {
  createQueryClient,
  QueryProvider,
  type QueryProviderProps,
} from './QueryProvider.js'

// PKCE / external-auth helpers (framework-neutral; storage + base URL injected).
export {
  beginExternalAuth,
  clearPendingExternalAuth,
  readPendingExternalAuth,
  type BeginExternalAuthInput,
  type PendingExternalAuth,
  type PkceStorage,
} from './pkce.js'

// Framework-neutral auth/session flows (token exchange, session shape).
export {
  createAuthSessionApi,
  type AuthSessionApi,
  type AuthSessionState,
  type BootstrapInput,
  type LoginInput,
  type SessionPayload,
  type SessionSnapshot,
  type TokenStore,
} from './auth-session.js'
