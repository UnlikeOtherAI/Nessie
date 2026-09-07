import { createApiClient as createCoreApiClient, type ApiClient } from '@nessie/client-core'

export type { ApiClient }

// Admin (Vite) resolves the API base URL from build-time env. This is the
// single web-specific seam; @nessie/client-core stays env-agnostic and has the
// base URL injected by the host (here).
export const getBaseUrl = (): string => {
  const configuredBaseUrl = import.meta.env?.VITE_API_BASE_URL?.trim()
  return configuredBaseUrl ? configuredBaseUrl.replace(/\/$/, '') : ''
}

/**
 * The executor connects directly, so it cannot use the browser's Vite proxy.
 * The origin comes from the pairing invitation the API mints, or from
 * `VITE_API_PUBLIC_URL` when this build declares one of its own.
 */
export const resolveExecutorApiOrigin = (configuredOrigin?: string): string => {
  const origin = configuredOrigin?.trim()
  if (!origin) {
    throw new Error(
      'The pairing invitation carried no API origin and this build sets no '
        + 'VITE_API_PUBLIC_URL; set NESSIE_API_PUBLIC_URL on the API or '
        + 'VITE_API_PUBLIC_URL on the admin build.',
    )
  }
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    return parsed.origin
  } catch {
    throw new Error(
      'The executor API origin must be an absolute http(s) URL '
        + '(NESSIE_API_PUBLIC_URL / VITE_API_PUBLIC_URL).',
    )
  }
}

export const getExecutorApiOrigin = (invitationApiBaseUrl?: string): string =>
  resolveExecutorApiOrigin(import.meta.env?.VITE_API_PUBLIC_URL || invitationApiBaseUrl)

export const createApiClient = (
  token: string | null,
  onUnauthorized?: () => Promise<string | null>,
): ApiClient =>
  createCoreApiClient({ baseUrl: getBaseUrl(), token, onUnauthorized })

// Re-export the shared API data-shape + schema types so existing
// `import { ... } from '../lib/api-client'` call sites keep working.
export type {
  AgentModelOption,
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentOwner,
  AgentRecord,
  AgentStatusResponse,
  AgentTriggerActivityRecord,
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AuthProviderDescriptor,
  BootstrapModeResponse,
  BuildMeProjectHandoffIntent,
  BuildMeProjectHandoffRequest,
  CallParticipantRecord,
  CallRecord,
  ChannelMetadataRecord,
  ChannelRecord,
  AgentBrowserLoginRecord,
  AgentBrowserRecord,
  AgentBrowserTabRecord,
  AgentBrowserTabsResponse,
  CloudBrowserConnectionRecord,
  MailboxConnectionRecord,
  MailboxConnectionScope,
  MailboxDiscoveryResult,
  MailboxTransportSecurity,
  CloudBrowserScope,
  CloudBrowserSessionDetail,
  CloudBrowserSessionSummary,
  MyBrowserLoginRecord,
  CommsCapabilityState,
  CommsConnectionDetail,
  CommsConnectionListResponse,
  CommsConnectionStartResponse,
  CommsConnectionStatus,
  CommsConnectionSummary,
  CommsProvider,
  CommsProviderAvailability,
  CommsProvidersResponse,
  CommsResourceRecord,
  CommsResourcesPatchRequest,
  CommsResourceToggle,
  CommsSyncJobRecord,
  CommsSyncPhase,
  CommsSyncStatus,
  GlobalAgentHomeResponse,
  GoogleCapabilityId,
  CreateFeedbackRequest,
  DeepTestReviewDepth,
  DeepTestReviewHandoffRequest,
  DeepWaterResearchDepth,
  DeepWaterAgentAccessResponse,
  DeepWaterAgentAccessTarget,
  DeepWaterResearchLauncherPreset,
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchRunRecord,
  ExecutorAccessChangeRequest,
  ExecutorAccessChangeResponse,
  ExecutorAccessViewResponse,
  ExecutorRecordResponse,
  FavoriteRecord,
  FavoriteTargetType,
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
  MessageReaction,
  MessageSearchResult,
  OrganizationSummary,
  PresenceEntry,
  PresenceListResponse,
  PresenceManualState,
  PresenceState,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantConfigSummary,
  PersonalAssistantInstanceRecord,
  PersonalAssistantPresenceParticipant,
  PersonalAssistantStateResponse,
  ProjectMemberRecord,
  ProjectRecord,
  ProductAccountLinkRecord,
  ProductAccountLinkStatus,
  ProductIntegrationRunStatus,
  ProductMcpInstallationRecord,
  ProductTeamEnablementAuthority,
  ProductTeamEnablementRecord,
  SetProductTeamEnablementRequest,
  SetDeepWaterAgentAccessRequest,
  SessionState,
  TeamRecord,
  ThreadMessageRecord,
  ThreadRecord,
  ToolCallEntry,
  ToolDescriptor,
  UnreadDirectMessagePreview,
  UnreadDirectMessageRecord,
  UnreadDirectMessagesResponse,
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
  WorkflowStepSamplesRecord,
  WorkflowStepRunStatus,
  WorkflowTemplateRecord,
} from '@nessie/client-core'
