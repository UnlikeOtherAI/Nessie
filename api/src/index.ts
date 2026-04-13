import { existsSync, readFileSync } from 'node:fs'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// Load .env from project root (parent of api/) before config is parsed
const envFile = resolve(import.meta.dirname, '../../.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import { createModelClient, createPgPool, ModelUsageTracker } from '@nessie/runtime'
import {
  CaptureThoughtBodySchema,
  CHAT_MESSAGE_MAX_CHARS,
  LinkThoughtsBodySchema,
  MeResponseSchema,
  RecordThoughtRecallSignalBodySchema,
  RecordOutcomeBodySchema,
  SearchThoughtsBodySchema,
  UpdatePreferencesSchema,
  WsClientMessageSchema,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type AuthorizedActionContext,
  type MeResponse,
  type TriggerEventDispatchJobPayload,
  type WsScope,
} from '@nessie/schemas'
import {
  createBootstrapTokenState,
  isBootstrapTokenExpired,
  type BootstrapTokenState,
} from './auth/bootstrap.js'
import { hashPassword, verifyPassword } from './auth/password.js'
import {
  issueSessionToken,
  verifySessionToken,
  type SessionTokenClaims,
} from './auth/session.js'
import {
  AcquireResourceLockBodySchema,
  AddChannelMemberBodySchema,
  AgentCategoryAgentBodySchema,
  AgentCategoryRecordSchema,
  AgentRecordSchema,
  AgentTriggerDeliveryRecordSchema,
  AgentTriggerRecordSchema,
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  ChannelRecordSchema,
  CreateMailboxMessageBodySchema,
  CreateExecutionEnvironmentTemplateBodySchema,
  CreateAgentBindingBodySchema,
  BlockWorkflowStepRunBodySchema,
  CancelWorkflowRunBodySchema,
  CreateAgentBodySchema,
  CreateAgentTriggerBodySchema,
  CreateAgentCategoryBodySchema,
  CreatePlanBodySchema,
  CreatePlanStepBodySchema,
  CreateWorkflowRunBodySchema,
  CreateWorkflowTemplateBodySchema,
  CreateWorkflowTriggerBodySchema,
  RetryWorkflowRunBodySchema,
  SkipWorkflowStepRunBodySchema,
  UnblockWorkflowStepRunBodySchema,
  CreateTemporaryContextSessionBodySchema,
  CreateToolRegistryEntryBodySchema,
  DesignerChatBodySchema,
  FireAgentTriggerBodySchema,
  CreateChannelBodySchema,
  CreateThreadMessageBodySchema,
  CreateUserBodySchema,
  LoginRequestSchema,
  MailboxMessageRecordSchema,
  PlanRecordSchema,
  PlanStepRecordSchema,
  PublishEventBodySchema,
  ResourceLockRecordSchema,
  ExecutionEnvironmentInstanceRecordSchema,
  ExecutionEnvironmentTemplateRecordSchema,
  ExecutionLeaseRecordSchema,
  ExecutionRunnerRecordSchema,
  ExecutionUsageLedgerRecordSchema,
  InstallWorkflowTemplateBodySchema,
  LaunchExecutionEnvironmentBodySchema,
  TemporaryContextSessionSchema,
  ThreadMessageRecordSchema,
  ToolDescriptorSchema,
  ToolRegistryEntrySchema,
  UpdateAgentTriggerBodySchema,
  UpdateAgentCategoryBodySchema,
  UserRecordSchema,
  WorkflowInstallationRecordSchema,
  WorkflowRunRecordSchema,
  WorkflowStepRunRecordSchema,
  WorkflowTemplateRecordSchema,
} from './contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from './db/bootstrap.js'
import { getPrismaClient } from './db/client.js'
import { seedBootstrapRecords } from './db/seed.js'
import { createApiResponse, parseInput, sendApiError } from './lib/api.js'
import { enqueueQueueJob, enqueueRunExecution } from './queue/pgqueue.js'
import { createRealtimeHub } from './realtime/hub.js'
import {
  addAgentToCategory,
  createAgentCategory,
  deleteAgentCategory,
  listAgentCategories,
  removeAgentFromCategory,
  updateAgentCategory,
} from './services/agent-categories.js'
import {
  bindAgentToChannel,
  buildSnapshotForScopes,
  cloneAgentRecord,
  createAgentRecord,
  listAgentsForUser,
  loadAgentActivity,
  loadAgentChildren,
  loadAgentMessages,
  loadAgentStatus,
  loadRunToolCalls,
  unbindAgentFromChannel,
} from './services/agents.js'
import {
  createAgentTrigger,
  createWorkflowTrigger,
  dispatchAgentTrigger,
  deleteAgentTrigger,
  getAgentTrigger,
  listOrganizationTriggers,
  listScheduledTriggers,
  listAgentTriggerDeliveries,
  listAgentTriggers,
  listWorkflowInstallationTriggers,
  pauseAgentTrigger,
  resumeAgentTrigger,
  updateAgentTrigger,
} from './services/triggers.js'
import {
  createTemporaryContextSession,
  dropTemporaryContextSession,
  listTemporaryContextSessions,
} from './services/capabilities.js'
import { streamDesignerChat } from './services/designer.js'
import {
  LOCAL_AUTH_PROVIDER_ID,
  buildMeResponse,
  createActorContextFromClaims,
  listAuthProviders,
  resolveConfiguredAuthProvider,
} from './services/auth.js'
import {
  addMemberToChannel,
  createChannelForUser,
  listChannelsForUser,
  removeMemberFromChannel,
} from './services/channels.js'
import {
  buildExternalAuthAuthorizeUrl,
  exchangeExternalAuthCode,
} from './services/external-auth.js'
import {
  addReaction,
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
} from './services/messages.js'
import {
  claimMailboxMessage,
  createMailboxMessage,
  listMailboxMessages,
  markMailboxMessageDelivered,
} from './services/mailbox.js'
import { decideAgentEngagement } from './services/orchestrator.js'
import {
  addPlanStep,
  createPlan,
  getPlan,
  listPlans,
} from './services/plans.js'
import {
  createExecutionEnvironmentTemplate,
  listExecutionEnvironmentInstances,
  listExecutionEnvironmentTemplates,
  listExecutionLeases,
  listExecutionRunners,
  listExecutionUsageLedger,
  requestExecutionEnvironmentLaunch,
} from './services/execution-environments.js'
import { requestExecutionEnvironmentTermination } from './services/execution-control-plane.js'
import {
  acquireResourceLock,
  listResourceLocks,
  releaseResourceLock,
} from './services/resource-locks.js'
import { createThoughtService } from './services/thoughts.js'
import {
  listAvailableTools,
  listToolRegistryEntries,
  registerToolRegistryEntry,
} from './services/tools.js'
import {
  blockWorkflowStepRun,
  cancelWorkflowRun,
  createWorkflowRun,
  createWorkflowTemplate,
  getWorkflowRun,
  getWorkflowTemplate,
  installWorkflowTemplate,
  listWorkflowInstallations,
  listWorkflowRuns,
  listWorkflowTemplates,
  retryWorkflowRun,
  skipWorkflowStepRun,
  unblockWorkflowStepRun,
  WorkflowActionError,
} from './services/workflows.js'
import {
  createUserForOrganization,
  listUsersForOrganization,
  loadSessionUserByEmail,
} from './services/users.js'
import {
  emitAuditEvent,
  getAuditLogEntry,
  getAuditLogSummary,
  listAuditLogs,
} from './services/audit.js'
import {
  checkPolicy,
  createPolicyRule,
  deletePolicyRule,
  getEffectivePolicy,
  listPolicyRules,
  seedDefaultPolicies,
  updatePolicyRule,
  addPolicyBinding,
  removePolicyBinding,
} from './services/policy.js'
import {
  getApprovalRequest,
  getPendingApprovalCount,
  listApprovalRequests,
  resolveApprovalRequest,
  sweepExpiredApprovals,
} from './services/approvals.js'
import {
  createPricingProfile,
  deletePricingProfile,
  getMonthlyEstimate,
  getTokenUsageSummary,
  listPricingProfiles,
} from './services/token-ledger.js'
import { registerInferenceControlPlaneRoutes } from './routes/inference-control-plane.js'

type AuthenticatedRequestState = {
  actorContext: AuthorizedActionContext
  claims: SessionTokenClaims
  me: MeResponse
}

type RequestWithRawBody = FastifyRequest & {
  rawBody?: Buffer
}

const DEFAULT_LOCAL_PROVIDER_TYPE = 'local-bootstrap'

const config = loadConfig()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = config.database.url
}
const databaseUrl = process.env.DATABASE_URL
const prisma = getPrismaClient()
const authSecret = (() => {
  if (config.auth.secret) return config.auth.secret
  if (config.mode === 'local') {
    // Local dev: generate a stable per-process secret with a warning
    console.warn('[auth] NESSIE_AUTH_SECRET not set — using ephemeral secret (tokens will not survive restarts)')
    return randomUUID()
  }
  console.error('[FATAL] NESSIE_AUTH_SECRET is required for hosted/selfHosted modes.')
  console.error('Multi-instance deployments WILL fail without a shared persistent secret.')
  process.exit(1)
})()
let bootstrapTokenState: BootstrapTokenState | null = null

const resolveBootstrapState = async (): Promise<BootstrapTokenState | null> => {
  const usersExist = (await prisma.user.count()) > 0
  if (usersExist) {
    bootstrapTokenState = null
    return null
  }

  if (!bootstrapTokenState || isBootstrapTokenExpired(bootstrapTokenState)) {
    bootstrapTokenState = createBootstrapTokenState()
  }

  return bootstrapTokenState
}

const logBootstrapUrl = (state: BootstrapTokenState): void => {
  const baseUrl = `http://${config.api.host === '0.0.0.0' ? 'localhost' : config.api.host}:${config.api.port}`
  console.log('First-time setup. Open this URL to create your owner account:')
  console.log(`${baseUrl}/admin/bootstrap?token=${state.token}`)
}

const getAuthorizationToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme === 'Bearer' && token) {
      return token
    }
  }

  const queryToken =
    (request.query as { token?: string } | undefined)?.token ??
    new URL(request.url, 'http://localhost').searchParams.get('token')

  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken
  }

  return null
}

const authenticateRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedRequestState | null> => {
  const token = getAuthorizationToken(request)
  if (!token) {
    sendApiError(reply, 401, 'AUTH_REQUIRED', 'Missing or invalid authorization header')
    return null
  }

  const verification = verifySessionToken(token, authSecret)
  if (!verification.ok) {
    sendApiError(reply, 401, verification.code, verification.message)
    return null
  }

  const user = await prisma.user.findUnique({
    where: { id: verification.claims.sub },
  })

  if (!user) {
    sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
    return null
  }

  const actorContext = createActorContextFromClaims(verification.claims)
  request.actorContext = actorContext

  return {
    actorContext,
    claims: verification.claims,
    me: await buildMeResponse(prisma, user, verification.claims, config),
  }
}

const requireActorContext = (
  request: FastifyRequest,
  reply: FastifyReply,
): AuthorizedActionContext | null => {
  if (request.actorContext) {
    return request.actorContext
  }

  sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
  return null
}

const requireOwner = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  if (actorContext.actor.roles?.includes('owner')) {
    return true
  }

  sendApiError(reply, 403, 'FORBIDDEN', 'Owner access required')
  return false
}

const requireUserActor = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): actorContext is AuthorizedActionContext & {
  actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
} => {
  if (actorContext.actor.actorType === 'user') {
    return true
  }

  sendApiError(reply, 403, 'FORBIDDEN', 'User actor required')
  return false
}

const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: {
    ...actorContext.actionContext,
    ...fields,
  },
})

const isAgentVisibleToUser = async (
  userId: string,
  organizationId: string,
  agentId: string,
): Promise<boolean> =>
  (await prisma.agent.count({
    where: {
      id: agentId,
      OR: [
        { organizationId },
        { bindings: { some: { channel: { organizationId } } } },
      ],
      bindings: {
        some: {
          channel: {
            members: {
              some: { userId },
            },
          },
        },
      },
    },
  })) > 0

const isAgentAccessibleToActor = async (
  actorContext: AuthorizedActionContext,
  agentId: string,
): Promise<boolean> => {
  if (actorContext.actor.roles?.includes('owner')) {
    return (
      await prisma.agent.count({
        where: {
          id: agentId,
          OR: [
            { organizationId: actorContext.tenant.organizationId },
            {
              bindings: {
                some: {
                  channel: {
                    organizationId: actorContext.tenant.organizationId,
                  },
                },
              },
            },
          ],
        },
      })
    ) > 0
  }

  return isAgentVisibleToUser(
    actorContext.actor.actorId,
    actorContext.tenant.organizationId,
    agentId,
  )
}

const isChannelVisibleToUser = async (
  userId: string,
  organizationId: string,
  channelId: string,
): Promise<boolean> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      organizationId: true,
      visibility: true,
      members: { where: { userId }, select: { id: true }, take: 1 },
    },
  })
  if (!channel) return false
  if (channel.organizationId !== organizationId) return false
  // Public channels are visible to all org members
  if (channel.visibility === 'public') return true
  // Protected and private channels require membership
  return channel.members.length > 0
}

const isChannelMember = async (userId: string, channelId: string): Promise<boolean> =>
  (await prisma.channelMember.count({ where: { userId, channelId } })) > 0

const isTriggerTargetWritableByActor = async (
  actorContext: AuthorizedActionContext,
  trigger: {
    targetChannelId?: string
    workflowInstallationId?: string
  },
): Promise<boolean> => {
  if (actorContext.actor.roles?.includes('owner')) {
    return true
  }

  if (trigger.workflowInstallationId) {
    return false
  }

  if (actorContext.actor.actorType !== 'user' || !trigger.targetChannelId) {
    return false
  }

  if (
    !(await isChannelVisibleToUser(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      trigger.targetChannelId,
    ))
  ) {
    return false
  }

  return isChannelMember(actorContext.actor.actorId, trigger.targetChannelId)
}

const isWorkflowInstallationAccessibleToActor = async (
  actorContext: AuthorizedActionContext,
  workflowInstallationId: string,
): Promise<boolean> =>
  (await prisma.workflowInstallation.count({
    where: {
      id: workflowInstallationId,
      organizationId: actorContext.tenant.organizationId,
    },
  })) > 0

const isTriggerAccessibleToActor = async (
  actorContext: AuthorizedActionContext,
  trigger: { agentId?: string; workflowInstallationId?: string },
): Promise<boolean> => {
  if (trigger.agentId) {
    return isAgentAccessibleToActor(actorContext, trigger.agentId)
  }
  if (trigger.workflowInstallationId) {
    return isWorkflowInstallationAccessibleToActor(
      actorContext,
      trigger.workflowInstallationId,
    )
  }
  return false
}

const buildWebhookSignature = (secret: string, payload: Buffer, prefix: string): string =>
  `${prefix}${createHmac('sha256', secret).update(payload).digest('hex')}`

const getRawBody = (request: FastifyRequest): Buffer =>
  (request as RequestWithRawBody).rawBody ?? Buffer.from('')

const isJsonContentType = (request: FastifyRequest): boolean => {
  const contentType = parseHeaderValue(request.headers['content-type'])
  if (!contentType) {
    return false
  }

  return /^application\/([a-z0-9.+-]+\+)?json($|;)/i.test(contentType)
}

const parseHeaderValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) {
    return parseHeaderValue(value[0])
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const resolveWebhookAuthMode = (
  config: unknown,
): 'signature' | 'token' => {
  if (
    config &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    (config as Record<string, unknown>)['authMode'] === 'token'
  ) {
    return 'token'
  }

  return 'signature'
}

const resolveWebhookHeaderNames = (
  config: unknown,
  key: 'deliveryIdHeader' | 'signatureHeader' | 'timestampHeader' | 'tokenHeader',
  fallback: string[],
): string[] => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return fallback
  }

  const value = (config as Record<string, unknown>)[key]
  if (typeof value === 'string' && value.length > 0) {
    return [value.toLowerCase()]
  }

  const pluralKey = `${key}s`
  const pluralValue = (config as Record<string, unknown>)[pluralKey]
  if (Array.isArray(pluralValue)) {
    const headers = pluralValue
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((entry) => entry.toLowerCase())
    if (headers.length > 0) {
      return headers
    }
  }

  return fallback
}

const resolveWebhookTimestampToleranceSeconds = (config: unknown): number | null => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null
  }

  const value = (config as Record<string, unknown>)['timestampToleranceSeconds']
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }

  return Math.floor(value)
}

const shouldBindWebhookTimestampToSignature = (config: unknown): boolean =>
  !!config &&
  typeof config === 'object' &&
  !Array.isArray(config) &&
  (config as Record<string, unknown>)['bindTimestampToSignature'] === true

const readFirstHeader = (
  request: FastifyRequest,
  names: string[],
): string | undefined => {
  for (const name of names) {
    const value = parseHeaderValue(request.headers[name])
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  return undefined
}

const parseWebhookTimestamp = (value: string): Date | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d+$/.test(trimmed)) {
    const numericValue = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(numericValue)) {
      return null
    }

    const milliseconds = trimmed.length >= 13 ? numericValue : numericValue * 1000
    const parsed = new Date(milliseconds)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const buildWebhookSignaturePayload = (input: {
  config: unknown
  request: FastifyRequest
}): Buffer | null => {
  const rawBody = getRawBody(input.request)
  if (!shouldBindWebhookTimestampToSignature(input.config)) {
    return rawBody
  }

  const timestampHeaders = resolveWebhookHeaderNames(input.config, 'timestampHeader', [
    'x-nessie-trigger-timestamp',
    'x-request-timestamp',
  ])
  const timestampValue = readFirstHeader(input.request, timestampHeaders)
  if (!timestampValue) {
    return null
  }

  return Buffer.concat([Buffer.from(`${timestampValue}.`), rawBody])
}

const isWebhookSignatureValid = (
  providedSignature: string | undefined,
  expectedSecret: string,
  payload: Buffer,
  prefix: string,
): boolean => {
  if (!providedSignature) {
    return false
  }

  const expectedSignature = buildWebhookSignature(expectedSecret, payload, prefix)
  const providedBuffer = Buffer.from(providedSignature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(providedBuffer, expectedBuffer)
}

const isWebhookTimestampFresh = (input: {
  config: unknown
  now?: Date
  request: FastifyRequest
}): boolean => {
  const toleranceSeconds = resolveWebhookTimestampToleranceSeconds(input.config)
  if (!toleranceSeconds) {
    return true
  }

  if (!shouldBindWebhookTimestampToSignature(input.config)) {
    return false
  }

  const timestampHeaders = resolveWebhookHeaderNames(input.config, 'timestampHeader', [
    'x-nessie-trigger-timestamp',
    'x-request-timestamp',
  ])
  const timestampValue = readFirstHeader(input.request, timestampHeaders)
  const parsedTimestamp = timestampValue ? parseWebhookTimestamp(timestampValue) : null
  if (!parsedTimestamp) {
    return false
  }

  return (
    Math.abs((input.now ?? new Date()).getTime() - parsedTimestamp.getTime()) <=
    toleranceSeconds * 1000
  )
}

const filterAuthorizedScopes = async (
  userId: string,
  tenantOrganizationId: string,
  scopes: WsScope[],
): Promise<WsScope[]> => {
  const authorizedScopes: WsScope[] = []

  for (const scope of scopes) {
    if (scope.kind === 'organization') {
      if (scope.organizationId === parseOrganizationId(tenantOrganizationId)) {
        authorizedScopes.push(scope)
      }
      continue
    }

    if (scope.kind === 'channel') {
      // WS event delivery requires channel membership for private/protected channels.
      // Public channels allow visibility but WS events still require membership
      // to prevent leaking real-time content to non-participants.
      if (await isChannelMember(userId, scope.channelId)) {
        authorizedScopes.push(scope)
      }
      continue
    }

    if (await isAgentVisibleToUser(userId, tenantOrganizationId, scope.agentId)) {
      authorizedScopes.push(scope)
    }
  }

  return authorizedScopes
}

const buildLocalSession = async (userId: string, roles: string[]) => {
  // Resolve user's actual memberships from DB instead of hardcoded bootstrap IDs
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      organizationMembers: { orderBy: { createdAt: 'asc' }, select: { organizationId: true, role: true } },
      projectMembers: { orderBy: { createdAt: 'asc' }, select: { projectId: true } },
      teamMembers: { orderBy: { createdAt: 'asc' }, select: { teamId: true } },
    },
  })

  const orgId = user?.organizationMembers[0]?.organizationId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.organizationId
  const projId = user?.projectMembers[0]?.projectId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.projectId
  const teamId = user?.teamMembers[0]?.teamId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId
  const resolvedRoles = roles.length > 0 ? roles : [user?.organizationMembers[0]?.role ?? 'member']

  return issueSessionToken(
    {
      sub: userId,
      org: orgId,
      proj: projId,
      team: teamId,
      roles: resolvedRoles,
      providerId: LOCAL_AUTH_PROVIDER_ID,
      providerType: DEFAULT_LOCAL_PROVIDER_TYPE,
    },
    authSecret,
    config.auth.tokenTtlSeconds,
  )
}

const buildSessionForUser = (input: {
  organizationId: string
  projectId: string
  providerId: string
  providerType: SessionTokenClaims['providerType']
  roles: string[]
  teamId: string
  userId: string
}) =>
  issueSessionToken(
    {
      sub: input.userId,
      org: input.organizationId,
      proj: input.projectId,
      team: input.teamId,
      roles: input.roles,
      providerId: input.providerId,
      providerType: input.providerType,
    },
    authSecret,
    config.auth.tokenTtlSeconds,
  )

const apiUsageTracker = new ModelUsageTracker()
let sharedModelClient: import('@nessie/runtime').ModelClient | null = null

export const buildApp = async () => {
  const app = Fastify({ logger: true })

  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json($|;)/i,
    { parseAs: 'buffer' },
    (request, body, done) => {
      ;(request as RequestWithRawBody).rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body)

      if (body.length === 0) {
        done(null, null)
        return
      }

      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (error) {
        done(error as Error)
      }
    },
  )

  // Create a single shared model client for all LLM calls (orchestrator, designer, memory)
  const modelApiKey =
    process.env.OPENAI_API_KEY
    ?? process.env.OPENAI_CHAT_API_KEY
    ?? config.model.apiKey
    ?? ''
  if (modelApiKey) {
    sharedModelClient = createModelClient(
      {
        apiKey: modelApiKey,
        provider: (config.model.provider ?? 'openai') as 'openai' | 'minimax',
      },
      apiUsageTracker,
    )
  } else {
    app.log.warn('No model API key configured — orchestrator, designer, and memory will fail')
  }

  const realtimeHub = await createRealtimeHub({
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
  })

  const memoryPool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })
  const thoughtService = sharedModelClient
    ? createThoughtService({
      pool: memoryPool,
      captureConfig: { pool: memoryPool, modelClient: sharedModelClient },
      searchConfig: { pool: memoryPool, modelClient: sharedModelClient },
    })
    : null

  await app.register(cors, { origin: true, credentials: true })
  await app.register(websocket)

  // Self-heal: ensure every pre-existing organization has the default policy
  // rules seeded. Bootstrap only runs on first install, so orgs provisioned
  // through migrations or older installs otherwise hit NO_MATCHING_ALLOW on
  // every agent bind / invoke. seedDefaultPolicies is idempotent per-org.
  try {
    const orgs = await prisma.organization.findMany({
      select: {
        id: true,
        members: {
          where: { role: 'owner' },
          select: { userId: true },
          take: 1,
        },
      },
    })
    for (const org of orgs) {
      const createdBy = org.members[0]?.userId ?? org.id
      await seedDefaultPolicies(prisma, org.id, createdBy)
    }
  } catch (error) {
    app.log.error({ err: error }, 'Failed to seed default policies on startup')
  }

  app.decorateRequest('actorContext', null)

  app.addHook('onClose', async () => {
    await realtimeHub.close()
    await memoryPool.end()
    await prisma.$disconnect()
  })

  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.public === true) {
      return
    }

    await authenticateRequest(request, reply)
  })

  app.get('/api/health', { config: { public: true } }, async () =>
    createApiResponse({
      service: 'api',
      status: 'ok',
    }),
  )

  app.get('/api/auth/providers', { config: { public: true } }, async () =>
    createApiResponse(
      AuthProviderDescriptorSchema.array().parse(listAuthProviders(config)),
    ),
  )

  app.get('/api/auth/providers/:providerId/authorize', { config: { public: true } }, async (request, reply) => {
    const query = parseInput(AuthProviderAuthorizeQuerySchema, request.query, reply)
    if (!query) {
      return reply
    }

    const providerId = (request.params as { providerId?: string } | undefined)?.providerId
    if (!providerId) {
      sendApiError(reply, 400, 'PROVIDER_REQUIRED', 'Provider id is required', 'providerId')
      return reply
    }

    const provider = resolveConfiguredAuthProvider(config, providerId)
    if (!provider) {
      sendApiError(reply, 404, 'PROVIDER_NOT_FOUND', 'Auth provider was not found', 'providerId')
      return reply
    }

    try {
      const authorizeUrl = await buildExternalAuthAuthorizeUrl(provider, query)
      return createApiResponse({ authorizeUrl })
    } catch (error) {
      sendApiError(
        reply,
        400,
        'PROVIDER_NOT_SUPPORTED',
        error instanceof Error ? error.message : 'Provider is not supported',
        'providerId',
      )
      return reply
    }
  })

  app.get('/api/auth/me', { config: { public: true } }, async (request, reply) => {
    const token = getAuthorizationToken(request)
    if (!token) {
      const state = await resolveBootstrapState()
      if (state) {
        return createApiResponse(BootstrapModeResponseSchema.parse({
          bootstrapMode: true,
          bootstrapUrl: '/admin/bootstrap',
        }))
      }

      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return reply
    }

    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) {
      return reply
    }

    return createApiResponse(MeResponseSchema.parse(authenticatedState.me))
  })

  app.patch('/api/auth/me/preferences', async (request, reply) => {
    const authenticatedState = await authenticateRequest(request, reply)
    if (!authenticatedState) {
      return reply
    }

    const body = parseInput(UpdatePreferencesSchema, request.body, reply)
    if (!body) {
      return reply
    }

    const updatedUser = await prisma.user.update({
      where: { id: authenticatedState.claims.sub },
      data: { preferences: body },
    })

    const me = await buildMeResponse(prisma, updatedUser, authenticatedState.claims, config)
    return createApiResponse(MeResponseSchema.parse(me))
  })

  app.post('/api/auth/bootstrap', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(BootstrapRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    const state = await resolveBootstrapState()
    if (!state) {
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }

    if (state.token !== body.bootstrapToken) {
      sendApiError(reply, 401, 'TOKEN_INVALID', 'Invalid bootstrap token')
      return reply
    }

    if (isBootstrapTokenExpired(state)) {
      bootstrapTokenState = null
      sendApiError(reply, 401, 'TOKEN_EXPIRED', 'Bootstrap token expired')
      return reply
    }

    if ((await prisma.user.count()) > 0) {
      bootstrapTokenState = null
      sendApiError(reply, 409, 'BOOTSTRAP_DISABLED', 'Bootstrap is no longer available')
      return reply
    }

    const passwordHash = await hashPassword(body.password)
    const result = await seedBootstrapRecords(prisma, {
      email: body.email,
      displayName: body.displayName,
      passwordHash,
    })
    await seedDefaultPolicies(prisma, result.organizationId, result.user.id)
    bootstrapTokenState = null

    const session = await buildLocalSession(result.user.id, ['owner'])
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue bootstrap session')
      return reply
    }

    return reply.code(201).send(
      createApiResponse({
        token: session.token,
        me: MeResponseSchema.parse(await buildMeResponse(prisma,result.user, verification.claims, config)),
      }),
    )
  })

  app.post('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LoginRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (body.providerId && body.providerId !== LOCAL_AUTH_PROVIDER_ID) {
      if (!body.code || !body.codeVerifier || !body.redirectUri) {
        sendApiError(
          reply,
          400,
          'EXTERNAL_AUTH_INCOMPLETE',
          'providerId, code, codeVerifier, and redirectUri are required',
        )
        return reply
      }

      const provider = resolveConfiguredAuthProvider(config, body.providerId)
      if (!provider) {
        sendApiError(reply, 404, 'PROVIDER_NOT_FOUND', 'Auth provider was not found', 'providerId')
        return reply
      }

      try {
        const identity = await exchangeExternalAuthCode(provider, {
          code: body.code,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
        })

        let sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        if (!sessionUser) {
          // Resolve the default org/project/team from DB for SSO auto-provisioning
          const defaultOrg = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } })
          const defaultProject = defaultOrg
            ? await prisma.project.findFirst({
                where: { organizationId: defaultOrg.id },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const defaultTeam = defaultProject
            ? await prisma.team.findFirst({
                where: { projectId: defaultProject.id },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const defaultChannel = defaultOrg
            ? await prisma.channel.findFirst({
                where: { organizationId: defaultOrg.id, visibility: 'public' },
                orderBy: { createdAt: 'asc' },
              })
            : null

          if (!defaultOrg || !defaultProject || !defaultTeam) {
            sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
            return reply
          }

          await createUserForOrganization(prisma, {
            avatarUrl: identity.avatarUrl,
            channelIds: defaultChannel ? [defaultChannel.id] : [],
            displayName: identity.displayName,
            email: identity.email,
            organizationId: defaultOrg.id,
            projectId: defaultProject.id,
            role: 'member',
            teamId: defaultTeam.id,
          })
          sessionUser = await loadSessionUserByEmail(prisma, identity.email)
        }

        if (!sessionUser) {
          sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
          return reply
        }

        const organizationMember = sessionUser.organizationMembers[0]
        const projectMember = sessionUser.projectMembers[0]
        const teamMember = sessionUser.teamMembers[0]
        if (!organizationMember || !projectMember || !teamMember) {
          sendApiError(reply, 403, 'FORBIDDEN', 'User is missing required workspace membership')
          return reply
        }

        const session = buildSessionForUser({
          organizationId: organizationMember.organizationId,
          projectId: projectMember.projectId,
          providerId: provider.providerId,
          providerType: provider.type,
          roles: [organizationMember.role],
          teamId: teamMember.teamId,
          userId: sessionUser.id,
        })
        const verification = verifySessionToken(session.token, authSecret)
        if (!verification.ok) {
          sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue external auth session')
          return reply
        }

        return createApiResponse({
          token: session.token,
          me: MeResponseSchema.parse(await buildMeResponse(prisma,sessionUser, verification.claims, config)),
        })
      } catch (error) {
        sendApiError(
          reply,
          401,
          'EXTERNAL_AUTH_FAILED',
          error instanceof Error ? error.message : 'External authentication failed',
        )
        return reply
      }
    }

    if (!body.email || !body.password) {
      sendApiError(reply, 400, 'PASSWORD_REQUIRED', 'Password is required', 'password')
      return reply
    }

    const user = await loadSessionUserByEmail(prisma, body.email)

    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
      return reply
    }

    const primaryOrganizationMember = user.organizationMembers[0]
    if (!primaryOrganizationMember) {
      sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
      return reply
    }

    const sessionRoles = [primaryOrganizationMember.role]
    const session = await buildLocalSession(user.id, sessionRoles)
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma,user, verification.claims, config)),
    })
  })

  app.get('/api/auth/dev-login', { config: { public: true } }, async (_request, reply) => {
    if (config.mode !== 'local') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available in local mode')
      return reply
    }

    const user = await prisma.user.findFirst({
      include: {
        organizationMembers: true,
        projectMembers: true,
        teamMembers: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    if (!user) {
      sendApiError(reply, 404, 'NO_USERS', 'No users exist yet')
      return reply
    }

    const organizationMember = user.organizationMembers[0]
    if (!organizationMember) {
      sendApiError(reply, 500, 'NO_MEMBERSHIP', 'User has no organization membership')
      return reply
    }

    const sessionRoles = [organizationMember.role]
    const session = await buildLocalSession(user.id, sessionRoles)
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue dev session')
      return reply
    }

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma,user, verification.claims, config)),
    })
  })

  app.delete('/api/auth/session', async (_request, reply) => {
    reply.code(204)
    return null
  })

  app.get('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = request.query as { teamId?: string }
    const channels = await listChannelsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      query.teamId,
    )

    return createApiResponse(ChannelRecordSchema.array().parse(channels))
  })

  app.post('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateChannelBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const channel = await createChannelForUser(prisma, {
      label: body.label,
      visibility: body.visibility ?? 'public',
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? '00000000-0000-4000-8000-000000000003',
      userId: actorContext.actor.actorId,
    })

    if (!channel) {
      sendApiError(reply, 400, 'HIERARCHY_VIOLATION', 'Team does not belong to this organization')
      return reply
    }

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })

  app.post('/api/channels/:channelId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const body = parseInput(AddChannelMemberBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    await addMemberToChannel(prisma, channelId, body.userId)
    return reply.code(204).send()
  })

  app.delete('/api/channels/:channelId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    await removeMemberFromChannel(prisma, channelId, userId)
    return reply.code(204).send()
  })

  app.get('/api/agents', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    const agents = await listAgentsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      isOwner,
    )
    return createApiResponse(AgentRecordSchema.array().parse(agents))
  })

  app.post('/api/agents', async (request, reply) => {
    if (!requireActorContext(request, reply)) {
      return reply
    }

    const body = parseInput(CreateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const agent = await createAgentRecord(prisma, {
      model: body.model,
      name: body.name,
      parentAgentId: body.parentAgentId,
      provider: body.provider,
      role: body.role ?? 'assistant',
      systemPrompt: body.systemPrompt,
      toolPolicy: body.toolPolicy,
    })

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(agent)))
  })

  app.post('/api/agents/:agentId/bindings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateAgentBindingBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (
      !(await isChannelVisibleToUser(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        body.channelId,
      ))
    ) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const { agentId } = request.params as { agentId: string }

    // Policy check: user must be allowed to bind agents
    const bindDecision = await checkPolicy(prisma, actorContext, 'agent', 'bind', {
      agentId,
      channelId: body.channelId,
    })
    if (!bindDecision.allowed) {
      sendApiError(reply, 403, 'POLICY_DENIED', `Agent binding denied: ${bindDecision.reasonCode}`)
      return reply
    }

    const agent = await bindAgentToChannel(prisma, agentId, body.channelId)
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
  })

  app.delete('/api/agents/:agentId/bindings/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, channelId } = request.params as { agentId: string; channelId: string }
    if (!(await isChannelVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    await unbindAgentFromChannel(prisma, agentId, channelId)
    return reply.code(204).send()
  })

  app.post('/api/agents/:agentId/clone', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const cloned = await cloneAgentRecord(prisma, agentId)
    if (!cloned) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(cloned)))
  })

  app.get('/api/agents/:agentId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const triggers = await listAgentTriggers(prisma, agentId)
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.post('/api/agents/:agentId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const body = parseInput(CreateAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (body.type === 'webhook' && typeof body.config?.['secret'] !== 'string') {
      sendApiError(reply, 400, 'WEBHOOK_SECRET_REQUIRED', 'Webhook triggers require a secret')
      return reply
    }

    const trigger = await createAgentTrigger(prisma, agentId, body)
    if (!trigger) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentTriggerRecordSchema.parse(trigger)))
  })

  app.put('/api/triggers/:triggerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const body = parseInput(UpdateAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const updated = await updateAgentTrigger(prisma, triggerId, body)
    if (!updated) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })

  app.delete('/api/triggers/:triggerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const deleted = await deleteAgentTrigger(prisma, triggerId)
    if (!deleted) {
      sendApiError(
        reply,
        409,
        'TRIGGER_DELETE_BLOCKED',
        'Trigger with delivery history cannot be deleted',
      )
      return reply
    }

    return reply.code(204).send()
  })

  app.post('/api/triggers/:triggerId/pause', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const updated = await pauseAgentTrigger(prisma, triggerId)
    if (!updated) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })

  app.post('/api/triggers/:triggerId/resume', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const updated = await resumeAgentTrigger(prisma, triggerId)
    if (!updated) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })

  app.post('/api/triggers/:triggerId/fire', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerTargetWritableByActor(actorContext, trigger))) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Trigger target is not writable by this actor')
      return reply
    }

    const body = parseInput(FireAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const dedupeKey =
      body.dedupeKey?.trim() || parseHeaderValue(request.headers['idempotency-key'])
    if (!dedupeKey) {
      sendApiError(
        reply,
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Manual trigger fire requires a dedupe key or Idempotency-Key header',
      )
      return reply
    }

    if (trigger.agentId) {
      const invokeDecision = await checkPolicy(prisma, actorContext, 'agent', 'invoke', {
        agentId: trigger.agentId,
      })
      if (!invokeDecision.allowed) {
        sendApiError(
          reply,
          403,
          'POLICY_DENIED',
          `Trigger fire denied: ${invokeDecision.reasonCode}`,
        )
        return reply
      }
    }

    const dispatched = await dispatchAgentTrigger(prisma, {
      actorContext,
      dedupeKey,
      payload: body.payload,
      prompt: body.prompt,
      source: body.source ?? 'manual',
      triggerId,
    })

    if (dispatched.kind === 'rejected') {
      if (dispatched.reason === 'agent_not_bound') {
        sendApiError(reply, 409, 'AGENT_NOT_BOUND', 'Agent must be bound to a channel before firing')
        return reply
      }
      if (dispatched.reason === 'workflow_installation_not_ready') {
        sendApiError(
          reply,
          409,
          'WORKFLOW_INSTALLATION_NOT_READY',
          'Workflow installation is not active',
        )
        return reply
      }

      sendApiError(reply, 409, 'TRIGGER_UNAVAILABLE', 'Trigger is not available for execution')
      return reply
    }

    return reply.code(202).send(
      createApiResponse({
        delivery: AgentTriggerDeliveryRecordSchema.parse(dispatched.delivery),
        existing: dispatched.existing,
        runId: dispatched.runId,
        trigger: AgentTriggerRecordSchema.parse(dispatched.trigger),
        workflowRunId: dispatched.workflowRunId,
      }),
    )
  })

  app.get('/api/triggers/:triggerId/history', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const trigger = await getAgentTrigger(prisma, triggerId)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 20 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }
    const limit = Math.min(Math.max(parsedLimit, 1), 100)

    const deliveries = await listAgentTriggerDeliveries(prisma, triggerId, limit)
    return createApiResponse(AgentTriggerDeliveryRecordSchema.array().parse(deliveries))
  })

  app.get('/api/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const triggers = await listOrganizationTriggers(prisma, actorContext.tenant.organizationId)
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.get('/api/triggers/scheduled', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }

    const triggers = await listScheduledTriggers(prisma, {
      organizationId: actorContext.tenant.organizationId,
      limit: Math.min(Math.max(parsedLimit, 1), 200),
    })
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.get('/api/triggers/upcoming', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }

    const triggers = await listScheduledTriggers(prisma, {
      dueBefore: new Date(),
      organizationId: actorContext.tenant.organizationId,
      limit: Math.min(Math.max(parsedLimit, 1), 200),
    })
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.post('/api/triggers/:triggerId/webhook', async (request, reply) => {
    const { triggerId } = request.params as { triggerId: string }
    const trigger = await prisma.agentTrigger.findUnique({
      where: { id: triggerId },
      select: {
        agentId: true,
        config: true,
        id: true,
        type: true,
      },
    })
    if (!trigger || trigger.type !== 'webhook') {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const expectedSecret =
      trigger.config &&
      typeof trigger.config === 'object' &&
      !Array.isArray(trigger.config) &&
      typeof (trigger.config as Record<string, unknown>)['secret'] === 'string'
        ? ((trigger.config as Record<string, unknown>)['secret'] as string)
        : undefined

    const authMode = resolveWebhookAuthMode(trigger.config)
    const signatureHeaders = resolveWebhookHeaderNames(trigger.config, 'signatureHeader', [
      'x-nessie-trigger-signature',
      'x-hub-signature-256',
    ])
    const tokenHeaders = resolveWebhookHeaderNames(trigger.config, 'tokenHeader', [
      'x-nessie-trigger-secret',
      'x-gitlab-token',
    ])
    const deliveryIdHeaders = resolveWebhookHeaderNames(trigger.config, 'deliveryIdHeader', [
      'x-nessie-delivery-id',
      'x-github-delivery',
      'x-request-id',
    ])
    const dedupeKey = readFirstHeader(request, deliveryIdHeaders)
    const signaturePrefix =
      trigger.config &&
      typeof trigger.config === 'object' &&
      !Array.isArray(trigger.config) &&
      typeof (trigger.config as Record<string, unknown>)['signaturePrefix'] === 'string'
        ? ((trigger.config as Record<string, unknown>)['signaturePrefix'] as string)
        : 'sha256='

    if (!dedupeKey) {
      sendApiError(reply, 400, 'WEBHOOK_DELIVERY_ID_REQUIRED', 'Webhook delivery id header missing')
      return reply
    }

    if (!expectedSecret) {
      sendApiError(reply, 403, 'WEBHOOK_SECRET_INVALID', 'Webhook secret missing')
      return reply
    }

    if (!isJsonContentType(request)) {
      sendApiError(reply, 415, 'WEBHOOK_CONTENT_TYPE_INVALID', 'Webhook requests must use JSON')
      return reply
    }

    if (authMode === 'token') {
      const providedToken = readFirstHeader(request, tokenHeaders)
      const providedBuffer = Buffer.from(providedToken ?? '')
      const expectedBuffer = Buffer.from(expectedSecret)
      if (
        providedBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        sendApiError(reply, 403, 'WEBHOOK_TOKEN_INVALID', 'Webhook token mismatch')
        return reply
      }
    } else {
      const signaturePayload = buildWebhookSignaturePayload({
        config: trigger.config,
        request,
      })
      if (!signaturePayload) {
        sendApiError(
          reply,
          403,
          'WEBHOOK_TIMESTAMP_INVALID',
          'Webhook timestamp is missing for signed verification',
        )
        return reply
      }

      if (
        !isWebhookSignatureValid(
          readFirstHeader(request, signatureHeaders),
          expectedSecret,
          signaturePayload,
          signaturePrefix,
        )
      ) {
        sendApiError(reply, 403, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature mismatch')
        return reply
      }
    }

    if (!isWebhookTimestampFresh({ config: trigger.config, request })) {
      sendApiError(reply, 403, 'WEBHOOK_TIMESTAMP_INVALID', 'Webhook timestamp is missing or stale')
      return reply
    }

    const dispatched = await dispatchAgentTrigger(prisma, {
      dedupeKey,
      payload: request.body,
      source: 'webhook',
      triggerId,
    })

    if (dispatched.kind === 'rejected') {
      if (dispatched.reason === 'agent_not_bound') {
        sendApiError(reply, 409, 'AGENT_NOT_BOUND', 'Agent must be bound to a channel before firing')
        return reply
      }

      sendApiError(reply, 409, 'TRIGGER_UNAVAILABLE', 'Trigger is not available for execution')
      return reply
    }

    return reply.code(202).send(
      createApiResponse({
        accepted: true,
        delivery: AgentTriggerDeliveryRecordSchema.parse(dispatched.delivery),
        existing: dispatched.existing,
        runId: dispatched.runId,
      }),
    )
  })

  app.post('/api/events', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(PublishEventBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const payload: TriggerEventDispatchJobPayload = {
      actorContext,
      dedupeKey: body.dedupeKey,
      eventType: body.eventType,
      payload: body.payload ?? {},
      source: body.source ?? `event:${body.eventType}`,
    }
    const queueIdempotencyKey = payload.dedupeKey
      ? `trigger-event:${actorContext.tenant.organizationId}:${payload.dedupeKey}`
      : undefined

    const enqueued = await enqueueQueueJob(prisma, {
      idempotencyKey: queueIdempotencyKey,
      payload,
      topic: 'trigger.event.dispatch',
    })

    return reply.code(202).send(
      createApiResponse({
        accepted: enqueued,
        eventType: payload.eventType,
        existing: !enqueued,
        source: payload.source,
      }),
    )
  })

  // ─── Agent Categories ─────────────────────────────────────────────────────

  app.get('/api/agent-categories', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const categories = await listAgentCategories(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(
      AgentCategoryRecordSchema.array().parse(categories),
    )
  })

  app.post('/api/agent-categories', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(CreateAgentCategoryBodySchema, request.body, reply)
    if (!body) return reply

    const category = await createAgentCategory(prisma, {
      name: body.name,
      description: body.description,
      visibility: body.visibility ?? 'public',
      organizationId: actorContext.tenant.organizationId,
      createdById: actorContext.actor.actorId,
      authorAgentId: body.authorAgentId,
    })

    return reply
      .code(201)
      .send(createApiResponse(AgentCategoryRecordSchema.parse(category)))
  })

  app.put('/api/agent-categories/:categoryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(
      UpdateAgentCategoryBodySchema,
      request.body,
      reply,
    )
    if (!body) return reply

    const { categoryId } = request.params as { categoryId: string }
    const category = await updateAgentCategory(prisma, categoryId, body)
    if (!category) {
      sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
      return reply
    }

    return createApiResponse(AgentCategoryRecordSchema.parse(category))
  })

  app.delete('/api/agent-categories/:categoryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { categoryId } = request.params as { categoryId: string }
    const deleted = await deleteAgentCategory(prisma, categoryId)
    if (!deleted) {
      sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
      return reply
    }

    return reply.code(204).send()
  })

  app.post(
    '/api/agent-categories/:categoryId/agents',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const body = parseInput(AgentCategoryAgentBodySchema, request.body, reply)
      if (!body) return reply

      const { categoryId } = request.params as { categoryId: string }
      const category = await addAgentToCategory(
        prisma,
        categoryId,
        body.agentId,
      )
      if (!category) {
        sendApiError(reply, 404, 'CATEGORY_NOT_FOUND', 'Category not found')
        return reply
      }

      return createApiResponse(AgentCategoryRecordSchema.parse(category))
    },
  )

  app.delete(
    '/api/agent-categories/:categoryId/agents/:agentId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const { categoryId, agentId } = request.params as {
        agentId: string
        categoryId: string
      }
      const removed = await removeAgentFromCategory(
        prisma,
        categoryId,
        agentId,
      )
      if (!removed) {
        sendApiError(
          reply,
          404,
          'LINK_NOT_FOUND',
          'Agent is not in this category',
        )
        return reply
      }

      return reply.code(204).send()
    },
  )

  app.get('/api/plans', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { agentId?: string; status?: string }
    const plans = await listPlans(prisma, actorContext.tenant.organizationId, {
      agentId: query.agentId,
      status:
        query.status &&
        ['draft', 'active', 'waiting', 'completed', 'failed', 'cancelled'].includes(query.status)
          ? (query.status as 'active' | 'cancelled' | 'completed' | 'draft' | 'failed' | 'waiting')
          : undefined,
    })
    return createApiResponse(PlanRecordSchema.array().parse(plans))
  })

  app.post('/api/plans', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreatePlanBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const plan = await createPlan(prisma, actorContext, body)
    return reply.code(201).send(createApiResponse(PlanRecordSchema.parse(plan)))
  })

  app.get('/api/plans/:planId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { planId } = request.params as { planId: string }
    const plan = await getPlan(prisma, actorContext.tenant.organizationId, planId)
    if (!plan) {
      sendApiError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found')
      return reply
    }

    return createApiResponse({
      plan: PlanRecordSchema.parse(plan.plan),
      steps: PlanStepRecordSchema.array().parse(plan.steps),
    })
  })

  app.post('/api/plans/:planId/steps', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreatePlanStepBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { planId } = request.params as { planId: string }
    let step
    try {
      step = await addPlanStep(prisma, actorContext.tenant.organizationId, planId, body)
    }
    catch (error) {
      if (error instanceof Error && error.message === 'PLAN_STEP_SEQUENCE_CONFLICT') {
        sendApiError(
          reply,
          409,
          'PLAN_STEP_SEQUENCE_CONFLICT',
          'A step with this sequence already exists for the plan',
        )
        return reply
      }
      throw error
    }
    if (!step) {
      sendApiError(reply, 404, 'PLAN_NOT_FOUND', 'Plan not found')
      return reply
    }

    return reply.code(201).send(createApiResponse(PlanStepRecordSchema.parse(step)))
  })

  app.get('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const workflows = await listWorkflowTemplates(prisma, actorContext.tenant.organizationId)
    return createApiResponse(WorkflowTemplateRecordSchema.array().parse(workflows))
  })

  app.post('/api/workflows', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let workflow
    try {
      workflow = await createWorkflowTemplate(prisma, actorContext, body)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND',
          'One or more required execution environment templates were not found',
        )
        return reply
      }
      throw error
    }

    return reply.code(201).send(createApiResponse(WorkflowTemplateRecordSchema.parse(workflow)))
  })

  app.get('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    const workflow = await getWorkflowTemplate(
      prisma,
      actorContext.tenant.organizationId,
      workflowTemplateId,
    )
    if (!workflow) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    return createApiResponse(WorkflowTemplateRecordSchema.parse(workflow))
  })

  app.post('/api/workflows/:workflowTemplateId/install', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(InstallWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    let installation
    try {
      installation = await installWorkflowTemplate(
        prisma,
        actorContext,
        workflowTemplateId,
        body,
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND') {
        sendApiError(
          reply,
          404,
          'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND',
          'Workflow installation channel not found',
        )
        return reply
      }
      throw error
    }

    if (!installation) {
      sendApiError(reply, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found')
      return reply
    }

    return reply
      .code(201)
      .send(createApiResponse(WorkflowInstallationRecordSchema.parse(installation)))
  })

  app.get('/api/workflow-installations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const installations = await listWorkflowInstallations(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(WorkflowInstallationRecordSchema.array().parse(installations))
  })

  app.post('/api/workflow-installations/:installationId/run', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateWorkflowRunBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    let workflowRun
    try {
      workflowRun = await createWorkflowRun(prisma, actorContext, installationId, body)
    } catch (error) {
      if (error instanceof Error) {
        const workflowRunErrorMap: Record<string, { code: string; message: string }> = {
          WORKFLOW_RUN_PARENT_RUN_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PARENT_RUN_NOT_FOUND',
            message: 'Parent run not found',
          },
          WORKFLOW_RUN_PLAN_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PLAN_NOT_FOUND',
            message: 'Plan not found',
          },
          WORKFLOW_RUN_PLAN_STEP_MISMATCH: {
            code: 'WORKFLOW_RUN_PLAN_STEP_MISMATCH',
            message: 'Plan step does not belong to the requested plan',
          },
          WORKFLOW_RUN_PLAN_STEP_NOT_FOUND: {
            code: 'WORKFLOW_RUN_PLAN_STEP_NOT_FOUND',
            message: 'Plan step not found',
          },
          WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH: {
            code: 'WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH',
            message: 'Trigger delivery does not belong to the requested trigger',
          },
          WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND: {
            code: 'WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND',
            message: 'Trigger delivery not found',
          },
          WORKFLOW_RUN_TRIGGER_NOT_FOUND: {
            code: 'WORKFLOW_RUN_TRIGGER_NOT_FOUND',
            message: 'Trigger not found',
          },
        }
        const mapped = workflowRunErrorMap[error.message]
        if (mapped) {
          sendApiError(reply, 404, mapped.code, mapped.message)
          return reply
        }
      }
      throw error
    }

    if (!workflowRun) {
      sendApiError(
        reply,
        404,
        'WORKFLOW_INSTALLATION_NOT_FOUND',
        'Workflow installation not found or inactive',
      )
      return reply
    }

    return reply.code(202).send(createApiResponse(WorkflowRunRecordSchema.parse(workflowRun)))
  })

  app.get('/api/workflow-installations/:installationId/runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    const runs = await listWorkflowRuns(prisma, actorContext.tenant.organizationId, {
      installationId,
    })
    return createApiResponse(WorkflowRunRecordSchema.array().parse(runs))
  })

  app.get('/api/workflow-installations/:installationId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    if (!(await isWorkflowInstallationAccessibleToActor(actorContext, installationId))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
      return reply
    }

    const triggers = await listWorkflowInstallationTriggers(prisma, installationId)
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.post('/api/workflow-installations/:installationId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { installationId } = request.params as { installationId: string }
    if (!(await isWorkflowInstallationAccessibleToActor(actorContext, installationId))) {
      sendApiError(reply, 404, 'WORKFLOW_INSTALLATION_NOT_FOUND', 'Workflow installation not found')
      return reply
    }

    const body = parseInput(CreateWorkflowTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (body.type === 'webhook' && typeof body.config?.['secret'] !== 'string') {
      sendApiError(reply, 400, 'WEBHOOK_SECRET_REQUIRED', 'Webhook triggers require a secret')
      return reply
    }

    const trigger = await createWorkflowTrigger(prisma, installationId, body)
    if (!trigger) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentTriggerRecordSchema.parse(trigger)))
  })

  app.get('/api/workflow-runs/:workflowRunId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    const workflowRun = await getWorkflowRun(prisma, actorContext.tenant.organizationId, workflowRunId)
    if (!workflowRun) {
      sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
      return reply
    }

    return createApiResponse({
      run: WorkflowRunRecordSchema.parse(workflowRun.run),
      steps: WorkflowStepRunRecordSchema.array().parse(workflowRun.steps),
    })
  })

  app.post('/api/workflow-runs/:workflowRunId/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CancelWorkflowRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    const cancelled = await cancelWorkflowRun(prisma, actorContext, workflowRunId, body)
    if (!cancelled) {
      sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
      return reply
    }

    return createApiResponse(WorkflowRunRecordSchema.parse(cancelled))
  })

  app.post('/api/workflow-runs/:workflowRunId/retry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RetryWorkflowRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowRunId } = request.params as { workflowRunId: string }
    try {
      const retried = await retryWorkflowRun(prisma, actorContext, workflowRunId, body)
      if (!retried) {
        sendApiError(reply, 404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run not found')
        return reply
      }
      return reply.code(202).send(createApiResponse(WorkflowRunRecordSchema.parse(retried)))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/skip', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(SkipWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await skipWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/block', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(BlockWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await blockWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.post('/api/workflow-step-runs/:workflowStepRunId/unblock', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UnblockWorkflowStepRunBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { workflowStepRunId } = request.params as { workflowStepRunId: string }
    try {
      const updated = await unblockWorkflowStepRun({
        prisma,
        actorContext,
        workflowStepRunId,
        reason: body.reason,
      })
      if (!updated) {
        sendApiError(reply, 404, 'WORKFLOW_STEP_RUN_NOT_FOUND', 'Workflow step run not found')
        return reply
      }
      return createApiResponse(WorkflowStepRunRecordSchema.parse(updated))
    } catch (error) {
      if (error instanceof WorkflowActionError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
  })

  app.get('/api/execution-environment-templates', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const templates = await listExecutionEnvironmentTemplates(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse(
      ExecutionEnvironmentTemplateRecordSchema.array().parse(templates),
    )
  })

  app.post('/api/execution-environment-templates', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateExecutionEnvironmentTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let template
    try {
      template = await createExecutionEnvironmentTemplate(prisma, actorContext, body)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND',
          'Execution environment channel not found',
        )
        return reply
      }
      throw error
    }

    return reply
      .code(201)
      .send(createApiResponse(ExecutionEnvironmentTemplateRecordSchema.parse(template)))
  })

  app.get('/api/execution-environment-instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { workflowRunId?: string }
    const instances = await listExecutionEnvironmentInstances(
      prisma,
      actorContext.tenant.organizationId,
      {
        workflowRunId: query.workflowRunId,
      },
    )
    return createApiResponse(
      ExecutionEnvironmentInstanceRecordSchema.array().parse(instances),
    )
  })

  app.post('/api/execution-environment-instances', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(LaunchExecutionEnvironmentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let instance
    try {
      instance = await requestExecutionEnvironmentLaunch(prisma, actorContext, body)
    } catch (error) {
      if (error instanceof Error) {
        const executionErrorMap: Record<string, { code: string; message: string }> = {
          EXECUTION_ENVIRONMENT_AGENT_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_AGENT_NOT_FOUND',
            message: 'Execution environment agent not found',
          },
          EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND',
            message: 'Execution environment channel not found',
          },
          EXECUTION_ENVIRONMENT_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_RUN_NOT_FOUND',
            message: 'Execution environment run not found',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_RUN_NOT_FOUND',
            message: 'Execution environment workflow run not found',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_MISMATCH: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_MISMATCH',
            message: 'Execution environment workflow step run does not belong to the workflow run',
          },
          EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_NOT_FOUND: {
            code: 'EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_NOT_FOUND',
            message: 'Execution environment workflow step run not found',
          },
        }
        const mapped = executionErrorMap[error.message]
        if (mapped) {
          sendApiError(reply, 404, mapped.code, mapped.message)
          return reply
        }
      }
      throw error
    }

    if (!instance) {
      sendApiError(
        reply,
        404,
        'EXECUTION_ENVIRONMENT_TEMPLATE_NOT_FOUND',
        'Execution environment template not found or disabled',
      )
      return reply
    }

    return reply
      .code(202)
      .send(createApiResponse(ExecutionEnvironmentInstanceRecordSchema.parse(instance)))
  })

  app.post('/api/execution-environment-instances/:instanceId/terminate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { instanceId } = request.params as { instanceId: string }
    const instance = await requestExecutionEnvironmentTermination(prisma, actorContext, {
      instanceId,
    })
    if (!instance) {
      sendApiError(
        reply,
        404,
        'EXECUTION_ENVIRONMENT_INSTANCE_NOT_FOUND',
        'Execution environment instance not found',
      )
      return reply
    }

    return reply
      .code(202)
      .send(createApiResponse(ExecutionEnvironmentInstanceRecordSchema.parse(instance)))
  })

  app.get('/api/execution-usage-ledger', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { instanceId?: string; workflowRunId?: string }
    const usage = await listExecutionUsageLedger(prisma, actorContext.tenant.organizationId, {
      instanceId: query.instanceId,
      workflowRunId: query.workflowRunId,
    })
    return createApiResponse(ExecutionUsageLedgerRecordSchema.array().parse(usage))
  })

  app.get('/api/execution-runners', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const runners = await listExecutionRunners(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ExecutionRunnerRecordSchema.array().parse(runners))
  })

  app.get('/api/execution-leases', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { instanceId?: string }
    const leases = await listExecutionLeases(prisma, actorContext.tenant.organizationId, {
      instanceId: query.instanceId,
    })
    return createApiResponse(ExecutionLeaseRecordSchema.array().parse(leases))
  })

  app.get('/api/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { planId?: string; toAgentId?: string }
    const messages = await listMailboxMessages(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(MailboxMessageRecordSchema.array().parse(messages))
  })

  app.post('/api/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateMailboxMessageBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let message
    try {
      message = await createMailboxMessage(prisma, actorContext.tenant.organizationId, body)
    } catch (error) {
      if (error instanceof Error && error.message === 'MAILBOX_THREAD_NOT_FOUND') {
        sendApiError(reply, 404, 'MAILBOX_THREAD_NOT_FOUND', 'Mailbox thread not found')
        return reply
      }
      if (error instanceof Error && error.message === 'MAILBOX_THREAD_CHANNEL_MISMATCH') {
        sendApiError(
          reply,
          400,
          'MAILBOX_THREAD_CHANNEL_MISMATCH',
          'Mailbox thread does not belong to the requested channel',
        )
        return reply
      }
      if (error instanceof Error && error.message === 'MAILBOX_CORRELATION_CONFLICT') {
        sendApiError(
          reply,
          409,
          'MAILBOX_CORRELATION_CONFLICT',
          'Correlation ID already belongs to a different mailbox message',
        )
        return reply
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(MailboxMessageRecordSchema.parse(message)))
  })

  app.post('/api/mailbox/:messageId/deliver', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }
    const delivery = await markMailboxMessageDelivered(
      prisma,
      actorContext.tenant.organizationId,
      messageId,
    )
    if (delivery.kind === 'not_found') {
      sendApiError(reply, 404, 'MAILBOX_MESSAGE_NOT_FOUND', 'Mailbox message not found')
      return reply
    }
    if (delivery.kind === 'not_deliverable') {
      sendApiError(
        reply,
        409,
        'MAILBOX_MESSAGE_NOT_DELIVERABLE',
        'Mailbox message must be claimed before it can be marked delivered',
      )
      return reply
    }

    return createApiResponse(MailboxMessageRecordSchema.parse(delivery.message))
  })

  app.post('/api/mailbox/:messageId/claim', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }
    const claim = await claimMailboxMessage(
      prisma,
      actorContext.tenant.organizationId,
      messageId,
    )
    if (claim.kind === 'not_found') {
      sendApiError(reply, 404, 'MAILBOX_MESSAGE_NOT_FOUND', 'Mailbox message not found')
      return reply
    }
    if (claim.kind === 'not_claimable') {
      sendApiError(
        reply,
        409,
        'MAILBOX_MESSAGE_NOT_CLAIMABLE',
        'Mailbox message is not currently claimable',
      )
      return reply
    }

    return createApiResponse(MailboxMessageRecordSchema.parse(claim.message))
  })

  app.get('/api/resource-locks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { agentId?: string }
    const locks = await listResourceLocks(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(ResourceLockRecordSchema.array().parse(locks))
  })

  app.post('/api/resource-locks/acquire', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(AcquireResourceLockBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const lock = await acquireResourceLock(prisma, actorContext.tenant.organizationId, body)
    if (!lock) {
      sendApiError(reply, 409, 'RESOURCE_LOCK_CONFLICT', 'Resource is already locked')
      return reply
    }

    return reply.code(201).send(createApiResponse(ResourceLockRecordSchema.parse(lock)))
  })

  app.post('/api/resource-locks/:lockId/release', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { lockId } = request.params as { lockId: string }
    const lock = await releaseResourceLock(prisma, actorContext.tenant.organizationId, lockId)
    if (!lock) {
      sendApiError(reply, 404, 'RESOURCE_LOCK_NOT_FOUND', 'Resource lock not found')
      return reply
    }

    return createApiResponse(ResourceLockRecordSchema.parse(lock))
  })

  app.get('/api/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const tools = await listAvailableTools(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ToolDescriptorSchema.array().parse(tools))
  })

  app.get('/api/tools/registry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const entries = await listToolRegistryEntries(prisma, actorContext.tenant.organizationId)
    return createApiResponse(ToolRegistryEntrySchema.array().parse(entries))
  })

  app.post('/api/tools/registry', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateToolRegistryEntryBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let entry
    try {
      entry = await registerToolRegistryEntry(
        prisma,
        actorContext.tenant.organizationId,
        body,
      )
    }
    catch (error) {
      if (error instanceof Error && error.message === 'BUILTIN_TOOL_ID_RESERVED') {
        sendApiError(
          reply,
          409,
          'BUILTIN_TOOL_ID_RESERVED',
          'Built-in tool ids are reserved and cannot be overridden by organization-local entries',
        )
        return reply
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(ToolRegistryEntrySchema.parse(entry)))
  })

  app.get('/api/capabilities/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as {
      agentId?: string
      includeDropped?: string
      runId?: string
      threadId?: string
    }
    const sessions = await listTemporaryContextSessions(prisma, actorContext.tenant.organizationId, {
      agentId: query.agentId,
      includeDropped: query.includeDropped === 'true',
      runId: query.runId,
      threadId: query.threadId,
    })
    return createApiResponse(TemporaryContextSessionSchema.array().parse(sessions))
  })

  app.post('/api/capabilities/sessions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateTemporaryContextSessionBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let session
    try {
      session = await createTemporaryContextSession(prisma, actorContext, body)
    }
    catch (error) {
      if (error instanceof Error) {
        if (error.message === 'TEMP_CONTEXT_SCOPE_REQUIRED') {
          sendApiError(
            reply,
            400,
            'TEMP_CONTEXT_SCOPE_REQUIRED',
            'A temporary context session must target exactly one of agentId, runId, or threadId',
          )
          return reply
        }
        if (error.message === 'TEMP_CONTEXT_SCOPE_AMBIGUOUS') {
          sendApiError(
            reply,
            400,
            'TEMP_CONTEXT_SCOPE_AMBIGUOUS',
            'A temporary context session may target only one of agentId, runId, or threadId',
          )
          return reply
        }
        if (error.message === 'TEMP_CONTEXT_AGENT_NOT_FOUND') {
          sendApiError(reply, 404, 'TEMP_CONTEXT_AGENT_NOT_FOUND', 'Agent not found')
          return reply
        }
        if (error.message === 'TEMP_CONTEXT_RUN_NOT_FOUND') {
          sendApiError(reply, 404, 'TEMP_CONTEXT_RUN_NOT_FOUND', 'Run not found')
          return reply
        }
        if (error.message === 'TEMP_CONTEXT_THREAD_NOT_FOUND') {
          sendApiError(reply, 404, 'TEMP_CONTEXT_THREAD_NOT_FOUND', 'Thread not found')
          return reply
        }
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(TemporaryContextSessionSchema.parse(session)))
  })

  app.delete('/api/capabilities/sessions/:sessionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { sessionId } = request.params as { sessionId: string }
    const session = await dropTemporaryContextSession(
      prisma,
      actorContext.tenant.organizationId,
      sessionId,
    )
    if (!session) {
      sendApiError(reply, 404, 'TEMP_CONTEXT_NOT_FOUND', 'Temporary context session not found')
      return reply
    }

    return createApiResponse(TemporaryContextSessionSchema.parse(session))
  })

  app.get('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const users = await listUsersForOrganization(prisma, actorContext.tenant.organizationId)
    return createApiResponse(UserRecordSchema.array().parse(users))
  })

  app.post('/api/users', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateUserBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    try {
      const passwordHash = await hashPassword(body.password)
      const user = await createUserForOrganization(prisma, {
        channelIds: body.channelIds,
        displayName: body.displayName,
        email: body.email,
        organizationId: actorContext.tenant.organizationId,
        passwordHash,
        projectId:
          actorContext.tenant.projectId ??
          '00000000-0000-4000-8000-000000000002',
        role: body.role ?? 'member',
        teamId:
          actorContext.tenant.teamId ??
          actorContext.actionContext.teamId ??
          '00000000-0000-4000-8000-000000000003',
      })

      return reply.code(201).send(createApiResponse(UserRecordSchema.parse(user)))
    } catch (error) {
      if (error instanceof Error && error.message === 'USER_ALREADY_EXISTS') {
        sendApiError(reply, 409, 'USER_ALREADY_EXISTS', 'A user with that email already exists')
        return reply
      }

      throw error
    }
  })

  // ─── Project CRUD ──────────────────────────────────────────────────────────

  app.get('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const projects = await prisma.project.findMany({
      where: { organizationId: actorContext.tenant.organizationId },
      include: { members: { select: { userId: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(projects.map((p) => ({
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      memberCount: p.members.length,
      createdAt: p.createdAt.toISOString(),
    })))
  })

  app.post('/api/projects', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as { name?: string } | undefined
    if (!body?.name) {
      sendApiError(reply, 400, 'NAME_REQUIRED', 'Project name is required')
      return reply
    }

    const project = await prisma.project.create({
      data: {
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        members: {
          create: { userId: actorContext.actor.actorId, role: 'owner' },
        },
      },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: project.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse({
      id: project.id,
      name: project.name,
      organizationId: project.organizationId,
      createdAt: project.createdAt.toISOString(),
    }))
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    await prisma.projectMember.create({
      data: {
        projectId,
        userId: body.userId,
        role: body.role ?? 'member',
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  // ─── Team CRUD ─────────────────────────────────────────────────────────────

  app.get('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as { projectId?: string }
    const where: Record<string, unknown> = {
      project: { organizationId: actorContext.tenant.organizationId },
    }
    if (query.projectId) {
      where['projectId'] = query.projectId
    }

    const teams = await prisma.team.findMany({
      where,
      include: { members: { select: { userId: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(teams.map((t) => ({
      id: t.id,
      name: t.name,
      projectId: t.projectId,
      memberCount: t.members.length,
      createdAt: t.createdAt.toISOString(),
    })))
  })

  app.post('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as { name?: string; projectId?: string } | undefined
    if (!body?.name || !body?.projectId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'name and projectId are required')
      return reply
    }

    const team = await prisma.team.create({
      data: {
        name: body.name,
        projectId: body.projectId,
        members: {
          create: { userId: actorContext.actor.actorId, role: 'owner' },
        },
      },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'team.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'team',
      resourceId: team.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse({
      id: team.id,
      name: team.name,
      projectId: team.projectId,
      createdAt: team.createdAt.toISOString(),
    }))
  })

  app.post('/api/teams/:teamId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { teamId } = request.params as { teamId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    await prisma.teamMember.create({
      data: {
        teamId,
        userId: body.userId,
        role: body.role ?? 'member',
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  // ─── Context Switching ─────────────────────────────────────────────────────

  app.post('/api/auth/switch-context', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = request.body as {
      organizationId?: string
      projectId?: string
      teamId?: string
    } | undefined

    if (!body?.organizationId || !body?.projectId || !body?.teamId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'organizationId, projectId, and teamId are required')
      return reply
    }

    // Verify membership
    const orgMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: body.organizationId, userId: actorContext.actor.actorId } },
    })
    if (!orgMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this organization')
      return reply
    }

    const session = buildSessionForUser({
      organizationId: body.organizationId,
      projectId: body.projectId,
      providerId: LOCAL_AUTH_PROVIDER_ID,
      providerType: DEFAULT_LOCAL_PROVIDER_TYPE as SessionTokenClaims['providerType'],
      roles: [orgMember.role],
      teamId: body.teamId,
      userId: actorContext.actor.actorId,
    })

    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue new session')
      return reply
    }

    const user = await prisma.user.findUnique({ where: { id: actorContext.actor.actorId } })
    if (!user) {
      sendApiError(reply, 500, 'USER_NOT_FOUND', 'User not found')
      return reply
    }

    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(await buildMeResponse(prisma, user, verification.claims, config)),
    })
  })

  app.get('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const messages = await listThreadMessages(prisma, thread.id)
    return createApiResponse(ThreadMessageRecordSchema.array().parse(messages))
  })

  app.post('/api/threads/:threadId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    // Guard oversized chat bodies BEFORE Zod validation so the client can
    // distinguish "too large, offer file upload" from generic validation
    // failures. Checked on the raw body.
    const rawContent =
      typeof request.body === 'object' &&
      request.body !== null &&
      'content' in request.body &&
      typeof (request.body as { content: unknown }).content === 'string'
        ? (request.body as { content: string }).content
        : null
    if (rawContent !== null && rawContent.length > CHAT_MESSAGE_MAX_CHARS) {
      reply.status(413).send({
        error: {
          code: 'MESSAGE_TOO_LARGE',
          message:
            `Message is ${rawContent.length} characters; the chat limit is ${CHAT_MESSAGE_MAX_CHARS}.` +
            ' Send as a file instead.',
          limit: CHAT_MESSAGE_MAX_CHARS,
          length: rawContent.length,
        },
      })
      return reply
    }

    const body = parseInput(CreateThreadMessageBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const result = await createThreadMessage(prisma, {
      content: body.content,
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })

    if (result.kind === 'thread_not_found') {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    // Use the orchestrator to decide agent engagement
    const scopes = [
      {
        kind: 'organization' as const,
        organizationId: actorContext.tenant.organizationId,
      },
      {
        kind: 'channel' as const,
        channelId: parseChannelId(thread.channel.id),
      },
    ]

    if (result.channelAgents.length > 0 && sharedModelClient) {
      // Fetch recent messages for context
      const recentDbMessages = await prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { agent: { select: { name: true } } },
      })

      const decisions = await decideAgentEngagement(sharedModelClient, {
        agents: result.channelAgents,
        content: body.content,
        recentMessages: recentDbMessages.reverse().slice(0, -1).map((m) => ({
          role: m.role,
          content: m.content,
          agentName: m.agent?.name ?? undefined,
        })),
      })

      for (const decision of decisions) {
        if (decision.action === 'reply') {
          const run = await prisma.run.create({
            data: {
              agentId: decision.agentId,
              threadId: thread.id,
              status: 'pending',
            },
            select: { agentId: true, id: true, status: true, threadId: true },
          })

          const task = await prisma.task.create({
            data: {
              runId: run.id,
              agentId: decision.agentId,
              status: 'inbox',
              purpose: body.content.slice(0, 200),
            },
            select: { id: true },
          })

          await realtimeHub.publishWs(
            [
              ...scopes,
              { kind: 'agent' as const, agentId: parseAgentId(decision.agentId) },
            ],
            {
              data: {
                agentId: parseAgentId(decision.agentId),
                contentPreview: result.message.content.slice(0, 200),
                messageId: result.message.id,
                role: result.message.role,
                threadId: parseThreadId(result.message.threadId),
              },
              event: 'message.new',
            },
          )

          await enqueueRunExecution(prisma, {
            actorContext: withActionContext(actorContext, {
              agentId: parseAgentId(run.agentId),
              channelId: parseChannelId(thread.channel.id),
              taskId: parseTaskId(task.id),
              threadId: parseThreadId(run.threadId),
            }),
            agentId: parseAgentId(run.agentId),
            messageId: result.message.id,
            runId: parseRunId(run.id),
            taskId: parseTaskId(task.id),
            threadId: parseThreadId(run.threadId),
          }, `run:${run.id}`)
        }

        if (decision.action === 'acknowledge') {
          await addReaction(prisma, {
            messageId: result.message.id,
            agentId: decision.agentId,
            emoji: decision.emoji,
          })

          const reactionData = {
            messageId: result.message.id,
            agentId: parseAgentId(decision.agentId),
            emoji: decision.emoji,
          }

          await realtimeHub.publishSse(thread.id, 'message.reaction', reactionData)
          await realtimeHub.publishWs(scopes, {
            data: reactionData,
            event: 'message.reaction',
          })
        }
      }
    }

    return reply.code(201).send(
      createApiResponse(
        ThreadMessageRecordSchema.parse({
          id: result.message.id,
          threadId: result.message.threadId,
          agentId: result.message.agentId ?? undefined,
          userId: result.message.userId ?? undefined,
          role: result.message.role,
          content: result.message.content,
          createdAt: result.message.createdAt.toISOString(),
        }),
      ),
    )
  })

  app.post('/api/threads/:threadId/messages/:messageId/reactions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, messageId } = request.params as { threadId: string; messageId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const body = request.body as { emoji?: string } | undefined
    if (!body?.emoji) {
      sendApiError(reply, 400, 'EMOJI_REQUIRED', 'Emoji is required')
      return reply
    }

    await addReaction(prisma, {
      messageId,
      userId: actorContext.actor.actorId,
      emoji: body.emoji,
    })

    await realtimeHub.publishWs(
      [
        { kind: 'organization', organizationId: actorContext.tenant.organizationId },
        { kind: 'channel', channelId: parseChannelId(thread.channel.id) },
      ],
      {
        data: { messageId, userId: actorContext.actor.actorId, emoji: body.emoji },
        event: 'message.reaction',
      },
    )

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  app.get('/api/threads/:threadId/stream', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(prisma, threadId, actorContext.actor.actorId)
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
    reply.raw.write(': stream connected\n\n')

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader

    const streamConnection = await realtimeHub.addSseConnection(
      thread.id,
      reply.raw,
      lastEventId,
    )

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    request.raw.on('close', () => {
      clearInterval(keepAlive)
      realtimeHub.removeSseConnection(streamConnection)
      reply.raw.end()
    })
  })

  app.get('/api/agents/:agentId/status', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const status = await loadAgentStatus(prisma, agentId)
    if (!status) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(status)
  })

  app.get('/api/agents/:agentId/activity', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const activity = await loadAgentActivity(prisma, agentId)
    if (!activity) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(activity)
  })

  app.get('/api/agents/:agentId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const query = request.query as { limit?: string; offset?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? '5'), 1), 50)
    const offset = Math.max(Number(query.offset ?? '0'), 0)
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentMessages(prisma, agentId, limit, actorContext.actor.actorId, offset))
  })

  app.get('/api/agents/:agentId/children', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentChildren(prisma, agentId))
  })

  app.get('/api/agents/:agentId/runs/:runId/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, runId } = request.params as { agentId: string; runId: string }
    if (!(await isAgentVisibleToUser(actorContext.actor.actorId, actorContext.tenant.organizationId, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadRunToolCalls(prisma, agentId, runId))
  })

  app.get('/api/activity', { websocket: true }, (socket, request) => {
    const actorContext = request.actorContext
    if (!actorContext) {
      socket.close(4001, 'Authentication required')
      return
    }

    const userId = actorContext.actor.actorId
    const tenantOrganizationId = actorContext.tenant.organizationId
    const wsConnection = realtimeHub.registerWsConnection((message) => {
      sendJson(message)
    })
    let currentScopes: WsScope[] = []
    let idleTimer: NodeJS.Timeout

    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        socket.close(4002, 'Idle timeout')
      }, 60000)
    }

    const sendJson = (value: unknown) => {
      socket.send(JSON.stringify(value))
    }

    resetIdleTimer()

    socket.on('message', async (rawMessage: Buffer) => {
      resetIdleTimer()

      let payload: unknown
      try {
        payload = JSON.parse(rawMessage.toString())
      } catch {
        sendJson({ type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON payload' })
        return
      }

      const parsed = WsClientMessageSchema.safeParse(payload)
      if (!parsed.success) {
        sendJson({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid WebSocket message' })
        return
      }

      if (parsed.data.type === 'ping') {
        sendJson({ type: 'pong', ts: new Date().toISOString() })
        return
      }

      if (parsed.data.type === 'unsubscribe') {
        const requested = new Set(parsed.data.scopes.map((scope) => JSON.stringify(scope)))
        currentScopes = currentScopes.filter((scope) => !requested.has(JSON.stringify(scope)))
        realtimeHub.setWsScopes(wsConnection, currentScopes)
        return
      }

      const nextScopes =
        parsed.data.type === 'set_subscriptions'
          ? parsed.data.scopes
          : [...currentScopes, ...parsed.data.scopes]

      currentScopes = await filterAuthorizedScopes(userId, tenantOrganizationId, nextScopes)
      realtimeHub.setWsScopes(wsConnection, currentScopes)
      const snapshot = await buildSnapshotForScopes(prisma, currentScopes)

      sendJson({
        type: 'subscribed',
        scopes: currentScopes,
        snapshot,
      })
    })

    socket.on('close', () => {
      clearTimeout(idleTimer)
      realtimeHub.removeWsConnection(wsConnection)
    })
  })

  const requireThoughtService = (reply: FastifyReply) => {
    if (!thoughtService) {
      sendApiError(reply, 503, 'SERVICE_UNAVAILABLE', 'Memory service not configured')
      return null
    }
    return thoughtService
  }

  // ─── Memory / Thoughts Routes ────────────────────────────────────────────

  app.post('/api/thoughts', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CaptureThoughtBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const result = await ts.capture({
      content: body.content,
      ownerId: actorContext.actor.actorId,
      ownerType: actorContext.actor.actorType,
      organizationId: actorContext.tenant.organizationId,
      projectId: body.projectId ?? actorContext.tenant.projectId,
      teamId: body.teamId ?? actorContext.tenant.teamId,
      channelId: body.channelId ?? actorContext.tenant.channelId ?? undefined,
      threadId: body.threadId ?? undefined,
      visibility: body.visibility,
      sensitivityTier: body.sensitivityTier,
      importance: body.importance,
    })

    return reply.code(201).send(createApiResponse(result))
  })

  app.post('/api/thoughts/search', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(SearchThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    try {
      const results = await ts.search({
        query: body.query,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        threshold: body.threshold,
        limit: body.limit,
        includeReasoning: body.includeReasoning,
        mode: body.mode,
        sessionId: actorContext.actionContext.sessionId,
        channelId:
          actorContext.actionContext.channelId ?? actorContext.tenant.channelId,
      })
      return createApiResponse(results)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed'
      return sendApiError(reply, 502, 'SEARCH_FAILED', msg)
    }
  })

  app.put('/api/thoughts/:id/outcome', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(RecordOutcomeBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const orgId = actorContext.tenant.organizationId

    const hasAccess = await ts.verifyAccess(id, orgId)
    if (!hasAccess) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    await ts.recordOutcome({
      thoughtId: id,
      outcome: body.outcome,
      outcomeNotes: body.outcomeNotes,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    return createApiResponse({ ok: true })
  })

  app.put('/api/thoughts/recalls/:id/signal', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(RecordThoughtRecallSignalBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const updated = await ts.recordRecallSignal({
      recallId: id,
      organizationId: actorContext.tenant.organizationId,
      userSignal: body.userSignal,
    })

    if (!updated) {
      return sendApiError(reply, 404, 'THOUGHT_RECALL_NOT_FOUND', 'Thought recall not found')
    }

    return createApiResponse({ ok: true })
  })

  app.post('/api/thoughts/:id/link', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(LinkThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const orgId = actorContext.tenant.organizationId

    // Verify both source and target belong to caller's org
    const [sourceOk, targetOk] = await Promise.all([
      ts.verifyAccess(id, orgId),
      ts.verifyAccess(body.targetId, orgId),
    ])
    if (!sourceOk || !targetOk) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    const linkId = await ts.link({
      sourceId: id,
      targetId: body.targetId,
      relation: body.relation,
      metadata: body.metadata,
      actorType: actorContext.actor.actorType,
      actorId: actorContext.actor.actorId,
    })

    if (!linkId) {
      return createApiResponse({ linkId: null, alreadyExists: true })
    }

    return reply.code(201).send(createApiResponse({ linkId }))
  })

  app.get('/api/experience/stats', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const actorId = (request.query as { actorId?: string }).actorId ?? null

    const stats = await ts.experienceStats(
      actorContext.tenant.organizationId,
      actorId,
    )

    return createApiResponse(stats)
  })

  // ─── Designer chat ────────────────────────────────────────────────────────

  app.post('/api/designer/chat', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(DesignerChatBodySchema, request.body, reply)
    if (!body) return reply

    if (!sharedModelClient) {
      reply.code(500).send({ error: 'Model client not configured' })
      return reply
    }

    await streamDesignerChat(reply, body, sharedModelClient)
    return reply
  })

  // ─── Phase 2: Audit Log Routes ──────────────────────────────────────────

  app.get('/api/audit-log', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const result = await listAuditLogs(prisma, {
      organizationId: actorContext.tenant.organizationId,
      action: query['action'],
      actorId: query['actorId'],
      resourceType: query['resourceType'],
      resourceId: query['resourceId'],
      projectId: query['projectId'],
      teamId: query['teamId'],
      channelId: query['channelId'],
      outcome: query['outcome'],
      from: query['from'],
      to: query['to'],
      cursor: query['cursor'],
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.get('/api/audit-log/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    const groupBy = (query['groupBy'] ?? 'action') as 'action' | 'actorId' | 'resourceType' | 'outcome'

    const result = await getAuditLogSummary(
      prisma,
      actorContext.tenant.organizationId,
      groupBy,
      query['from'],
      query['to'],
    )

    return createApiResponse(result)
  })

  app.get('/api/audit-log/:entryId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { entryId } = request.params as { entryId: string }
    const entry = await getAuditLogEntry(prisma, entryId, actorContext.tenant.organizationId)
    if (!entry) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Audit log entry not found')
      return reply
    }

    return createApiResponse(entry)
  })

  // ─── Phase 2: Policy Routes ─────────────────────────────────────────────

  app.get('/api/policy/effective', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const result = await getEffectivePolicy(prisma, actorContext)
    return createApiResponse(result)
  })

  app.post('/api/policy/check', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = request.body as { resourceType?: string; action?: string } | undefined
    if (!body?.resourceType || !body?.action) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'resourceType and action are required')
      return reply
    }

    const decision = await checkPolicy(
      prisma,
      actorContext,
      body.resourceType as Parameters<typeof checkPolicy>[2],
      body.action as Parameters<typeof checkPolicy>[3],
    )

    return createApiResponse(decision)
  })

  app.get('/api/policy/rules', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as Record<string, string | undefined>
    type ListPolicyRulesFilters = Parameters<typeof listPolicyRules>[2]
    const result = await listPolicyRules(prisma, actorContext.tenant.organizationId, {
      scope: query['scope'] as ListPolicyRulesFilters extends { scope?: infer S } ? S : never,
      scopeId: query['scopeId'],
      resourceType:
        query['resourceType'] as ListPolicyRulesFilters extends { resourceType?: infer R }
          ? R
          : never,
      cursor: query['cursor'],
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.post('/api/policy/rules', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as {
      scope: string
      scopeId: string
      resourceType: string
      action: string
      effect: string
      priority?: number
      conditions?: Record<string, unknown>
      bindings?: Array<{ actorType: string; actorId: string }>
    }

    const rule = await createPolicyRule(prisma, {
      organizationId: actorContext.tenant.organizationId,
      scope: body.scope as Parameters<typeof createPolicyRule>[1]['scope'],
      scopeId: body.scopeId,
      resourceType: body.resourceType as Parameters<typeof createPolicyRule>[1]['resourceType'],
      action: body.action as Parameters<typeof createPolicyRule>[1]['action'],
      effect: body.effect as Parameters<typeof createPolicyRule>[1]['effect'],
      priority: body.priority,
      conditions: body.conditions,
      createdBy: actorContext.actor.actorId,
      bindings: body.bindings,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.created',
      resourceType: 'policy',
      resourceId: rule.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse(rule))
  })

  app.put('/api/policy/rules/:ruleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    const body = request.body as {
      effect?: string
      priority?: number
      conditions?: Record<string, unknown> | null
    }

    const rule = await updatePolicyRule(prisma, ruleId, actorContext.tenant.organizationId, {
      effect: body.effect as Parameters<typeof updatePolicyRule>[3]['effect'],
      priority: body.priority,
      conditions: body.conditions,
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
    })

    return createApiResponse(rule)
  })

  app.delete('/api/policy/rules/:ruleId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    await deletePolicyRule(prisma, ruleId, actorContext.tenant.organizationId)

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'policy.deleted',
      resourceType: 'policy',
      resourceId: ruleId,
      outcome: 'success',
    })

    return reply.code(204).send()
  })

  app.post('/api/policy/rules/:ruleId/bindings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { ruleId } = request.params as { ruleId: string }
    const body = request.body as { actorType: string; actorId: string }

    const binding = await addPolicyBinding(prisma, ruleId, body.actorType, body.actorId)
    return reply.code(201).send(createApiResponse(binding))
  })

  app.delete('/api/policy/rules/:ruleId/bindings/:bindingId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { bindingId } = request.params as { ruleId: string; bindingId: string }
    await removePolicyBinding(prisma, bindingId)
    return reply.code(204).send()
  })

  // ─── Phase 2: Approval Routes ───────────────────────────────────────────

  app.get('/api/approvals', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const result = await listApprovalRequests(prisma, actorContext.tenant.organizationId, {
      status: query['status'],
      agentId: query['agentId'],
      channelId: query['channelId'],
      cursor: query['cursor'],
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.get('/api/approvals/pending/count', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const count = await getPendingApprovalCount(prisma, actorContext.tenant.organizationId)
    return createApiResponse({ count })
  })

  app.get('/api/approvals/:approvalId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const approval = await getApprovalRequest(prisma, approvalId, actorContext.tenant.organizationId)
    if (!approval) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    return createApiResponse(approval)
  })

  app.post('/api/approvals/:approvalId/resolve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const body = request.body as { resolution: 'approved' | 'rejected'; note?: string }

    if (!body?.resolution || !['approved', 'rejected'].includes(body.resolution)) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'resolution must be "approved" or "rejected"')
      return reply
    }

    const result = await resolveApprovalRequest(
      prisma,
      approvalId,
      actorContext,
      body.resolution,
      body.note,
    )

    if (!result) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    if ('error' in result && result.error) {
      const errorMap: Record<string, { code: number; message: string }> = {
        ALREADY_RESOLVED: { code: 409, message: 'Approval already resolved' },
        SELF_APPROVAL: { code: 403, message: 'Cannot approve your own request' },
        EXPIRED: { code: 410, message: 'Approval request has expired' },
      }
      const err = errorMap[result.error] ?? { code: 400, message: 'Unknown error' }
      sendApiError(reply, err.code, result.error, err.message)
      return reply
    }

    // Publish WS event for approval resolution
    await realtimeHub.publishWs(
      [{ kind: 'organization', organizationId: actorContext.tenant.organizationId }],
      {
        data: {
          approvalId,
          taskId: parseTaskId(result.approval.taskId ?? '00000000-0000-4000-8000-000000000000'),
          agentId: parseAgentId(result.approval.agentId),
          outcome: body.resolution,
          resolverId: actorContext.actor.actorId,
          resolvedAt: new Date().toISOString(),
        },
        event: 'approval.resolved',
      },
    )

    return createApiResponse(result.approval)
  })

  // ─── Phase 2: Token Ledger Routes ───────────────────────────────────────

  app.get('/api/ledger/tokens/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const summary = await getTokenUsageSummary(prisma, actorContext.tenant.organizationId, {
      projectId: query['projectId'],
      teamId: query['teamId'],
      channelId: query['channelId'],
      agentId: query['agentId'],
      actorId: query['actorId'],
      provider: query['provider'],
      model: query['model'],
      from: query['from'],
      to: query['to'],
      groupBy: query['groupBy'],
    })

    return createApiResponse(summary)
  })

  app.get('/api/ledger/tokens/monthly-estimate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const estimate = await getMonthlyEstimate(prisma, actorContext.tenant.organizationId)
    return createApiResponse(estimate)
  })

  app.get('/api/ledger/tokens/pricing', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const profiles = await listPricingProfiles(prisma, actorContext.tenant.organizationId)
    return createApiResponse(profiles)
  })

  app.post('/api/ledger/tokens/pricing', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as {
      provider: string
      modelPattern: string
      currency?: string
      source: string
      inputPerMillion?: number
      outputPerMillion?: number
    }

    const profile = await createPricingProfile(
      prisma,
      actorContext.tenant.organizationId,
      {
        provider: body.provider,
        modelPattern: body.modelPattern,
        currency: body.currency,
        source: body.source as Parameters<typeof createPricingProfile>[2]['source'],
        inputPerMillion: body.inputPerMillion,
        outputPerMillion: body.outputPerMillion,
      },
      actorContext,
    )

    return reply.code(201).send(createApiResponse(profile))
  })

  app.delete('/api/ledger/tokens/pricing/:profileId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { profileId } = request.params as { profileId: string }
    await deletePricingProfile(prisma, profileId, actorContext.tenant.organizationId, actorContext)
    return reply.code(204).send()
  })

  // ─── Inference control plane routes ─────────────────────────────────────
  registerInferenceControlPlaneRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── Phase 2: Approval sweep (periodic) ─────────────────────────────────

  // Run approval expiry sweep every 60 seconds
  const approvalSweepInterval = setInterval(async () => {
    try {
      await sweepExpiredApprovals(prisma)
    } catch {
      console.error('[approval-sweep] Failed to sweep expired approvals')
    }
  }, 60_000)

  app.addHook('onClose', () => {
    clearInterval(approvalSweepInterval)
  })

  return app
}

export const startApiServer = async () => {
  const app = await buildApp()
  const initialBootstrapState = await resolveBootstrapState()
  if (initialBootstrapState) {
    logBootstrapUrl(initialBootstrapState)
  }

  await app.listen({
    host: config.api.host,
    port: config.api.port,
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApiServer()
}
