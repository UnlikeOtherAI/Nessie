import { existsSync, readFileSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
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
import cors, { type FastifyCorsOptions } from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import { captureUserMessageMemory } from '@nessie/memory'
import { createModelClient, createPgPool, ModelUsageTracker } from '@nessie/runtime'
import {
  CaptureThoughtBodySchema,
  CHAT_MESSAGE_MAX_CHARS,
  LinkThoughtsBodySchema,
  MeResponseSchema,
  PersonalAssistantConfigSummarySchema,
  RecordThoughtRecallSignalBodySchema,
  RecordOutcomeBodySchema,
  SearchThoughtsBodySchema,
  UpdatePreferencesSchema,
  WsClientMessageSchema,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  TaskStatusSchema,
  type AuthorizedActionContext,
  type MeResponse,
  type TriggerEventDispatchJobPayload,
  type WsScope,
  withActionContext,
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
  AgentRecordSchema,
  AgentTriggerDeliveryRecordSchema,
  AgentTriggerRecordSchema,
  AuthProviderAuthorizeQuerySchema,
  AuthProviderDescriptorSchema,
  BootstrapModeResponseSchema,
  BootstrapRequestSchema,
  CallRecordSchema,
  ChannelRecordSchema,
  CreateMailboxMessageBodySchema,
  CreateExecutionEnvironmentTemplateBodySchema,
  CreateAgentBindingBodySchema,
  BlockWorkflowStepRunBodySchema,
  CancelWorkflowRunBodySchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  CreateAgentTriggerBodySchema,
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
  AssignableUserSchema,
  AssignTaskBodySchema,
  CreateTaskBodySchema,
  TaskRecordSchema,
  TransitionTaskBodySchema,
  OpsHealthResponseSchema,
  ReadinessResponseSchema,
  BudgetStatusResponseSchema,
  BudgetScopeTypeSchema,
  SetBudgetBodySchema,
  LoginRequestSchema,
  MailboxMessageRecordSchema,
  PlanRecordSchema,
  PlanStepRecordSchema,
  ProjectRecordSchema,
  PublishEventBodySchema,
  ResourceLockRecordSchema,
  ExecutionEnvironmentInstanceRecordSchema,
  ExecutionEnvironmentTemplateRecordSchema,
  ExecutionLeaseRecordSchema,
  ExecutionRunnerRecordSchema,
  ExecutionUsageLedgerRecordSchema,
  EmptyBodySchema,
  InstallWorkflowTemplateBodySchema,
  UpdateWorkflowTemplateBodySchema,
  LaunchExecutionEnvironmentBodySchema,
  PersonalAssistantBootstrapResponseSchema,
  PersonalAssistantStateResponseSchema,
  TemporaryContextSessionSchema,
  ThreadMessageRecordSchema,
  ThreadRecordSchema,
  ToolDescriptorSchema,
  ToolRegistryEntrySchema,
  UpdateAgentTriggerBodySchema,
  UpdateProjectBodySchema,
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
import { enqueueOrchestrateDecide, enqueueQueueJob } from './queue/pgqueue.js'
import { createRealtimeHub } from './realtime/hub.js'
import {
  bindAgentToChannel,
  buildAccessibleChannelWhere,
  buildSnapshotForScopes,
  cloneAgentRecord,
  createAgentRecord,
  updateAgentRecord,
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
  createGroupFromDm,
  ensureDefaultThread,
  findOrCreateDmChannel,
  listChannelsForUser,
  removeMemberFromChannel,
} from './services/channels.js'
import { ensurePersonalAssistantBootstrap } from './services/personal-assistant.js'
import {
  createCall,
  endCall,
  getActiveCallForChannel,
  joinCall,
  leaveCall,
} from './services/calls.js'
import {
  buildExternalAuthAuthorizeUrl,
  exchangeExternalAuthCode,
} from './services/external-auth.js'
import {
  addReaction,
  createThreadMessage,
  findThreadForUser,
  listThreadMessages,
  markThreadRead,
} from './services/messages.js'
import {
  claimMailboxMessage,
  createMailboxMessage,
  listMailboxMessages,
  markMailboxMessageDelivered,
} from './services/mailbox.js'
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
import {
  resolveThoughtCaptureAudience,
  resolveThoughtOutputAudience,
} from './services/thought-audiences.js'
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
  updateWorkflowTemplate,
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
  assignTask,
  createHumanTask,
  getTask,
  listAssignableUsers,
  listTasks,
  transitionTask,
} from './services/tasks.js'
import { getOpsHealth, getReadiness } from './services/ops-health.js'
import { checkBudget, deleteBudget, listBudgetStatuses, setBudgetConfig } from '@nessie/runtime'
import {
  createPricingProfile,
  deletePricingProfile,
  getMonthlyEstimate,
  getTokenUsageSummary,
  listPricingProfiles,
} from './services/token-ledger.js'
import { registerInferenceControlPlaneRoutes } from './routes/inference-control-plane.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerToolBundleRoutes } from './routes/tools-bundles.js'

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

const parseOriginList = (...values: Array<string | undefined>): Set<string> => {
  const origins = new Set<string>()
  for (const value of values) {
    for (const origin of value?.split(',') ?? []) {
      const trimmed = origin.trim().replace(/\/$/, '')
      if (trimmed) {
        origins.add(trimmed)
      }
    }
  }
  return origins
}

const localCorsOrigins = new Set([
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5555',
  'http://localhost:3000',
  'http://localhost:5555',
])

export const createCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: typeof config.mode
}): NonNullable<FastifyCorsOptions['origin']> =>
  (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }

    const normalizedOrigin = origin.replace(/\/$/, '')
    if (
      input.allowedOrigins.has(normalizedOrigin)
      || (input.mode === 'local' && localCorsOrigins.has(normalizedOrigin))
    ) {
      callback(null, true)
      return
    }

    callback(null, false)
  }

const allowedCorsOrigins = parseOriginList(
  process.env.NESSIE_CORS_ORIGINS,
  process.env.NESSIE_ALLOWED_ORIGINS,
  process.env.NESSIE_ADMIN_ORIGIN,
  process.env.NESSIE_WEB_ORIGIN,
  process.env.ADMIN_ORIGIN,
  process.env.WEB_ORIGIN,
)

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
let bootstrapExpiryWarned = false

const resolveBootstrapState = async (): Promise<BootstrapTokenState | null> => {
  const usersExist = (await prisma.user.count()) > 0
  if (usersExist) {
    bootstrapTokenState = null
    return null
  }

  // Mint exactly once at startup (or first call). After the initial token
  // expires without being consumed, do NOT auto-rotate — return the expired
  // state so callers (e.g. POST /api/auth/bootstrap) reject with
  // TOKEN_EXPIRED. An explicit restart is required to mint a fresh token.
  if (!bootstrapTokenState) {
    bootstrapTokenState = createBootstrapTokenState()
    return bootstrapTokenState
  }

  if (isBootstrapTokenExpired(bootstrapTokenState) && !bootstrapExpiryWarned) {
    bootstrapExpiryWarned = true
    console.warn(
      '[auth] Initial bootstrap token has expired without being consumed.'
        + ' Restart the API process to mint a new bootstrap token.',
    )
  }

  return bootstrapTokenState
}

const logBootstrapUrl = (state: BootstrapTokenState): void => {
  const baseUrl = `http://${config.api.host === '0.0.0.0' ? 'localhost' : config.api.host}:${config.api.port}`
  console.log('First-time setup. Open this URL to create your owner account:')
  console.log(`${baseUrl}/bootstrap?token=${state.token}`)
}

const getAuthorizationToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme === 'Bearer' && token) {
      return token
    }
  }

  // Narrow exception: WebSocket upgrade requests may carry the token in the
  // query string because the browser WebSocket API cannot set custom headers.
  if (request.headers.upgrade?.toLowerCase() === 'websocket') {
    const query = request.query as { token?: unknown } | undefined
    if (query && typeof query.token === 'string' && query.token) {
      return query.token
    }
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

const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

// Validate a client-supplied membership role against the allowed vocabulary,
// defaulting to 'member' when omitted. Returns null for an unknown role so the
// route can surface a 400 instead of persisting an arbitrary string.
const resolveMembershipRole = (role: string | undefined): MembershipRole | null => {
  if (role === undefined) {
    return 'member'
  }
  return (MEMBERSHIP_ROLES as readonly string[]).includes(role)
    ? (role as MembershipRole)
    : null
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

const isPersonalAssistantChannelType = (
  value: string | null | undefined,
): value is 'personal_assistant' => value === 'personal_assistant'

const buildChannelRealtimeScopes = (input: {
  channelId: string
  organizationId: string
  systemChannelType?: string | null
}): WsScope[] =>
  isPersonalAssistantChannelType(input.systemChannelType)
    ? [{ kind: 'channel', channelId: parseChannelId(input.channelId) }]
    : [
        {
          kind: 'organization',
          organizationId: parseOrganizationId(input.organizationId),
        },
        { kind: 'channel', channelId: parseChannelId(input.channelId) },
      ]

const buildPersonalAssistantConfigSummary = (agent: {
  id: string
  model: string | null
  provider: string | null
  systemPrompt: string | null
  toolPolicy: unknown
  updatedAt: Date
}) =>
  PersonalAssistantConfigSummarySchema.parse({
    agentId: parseAgentId(agent.id),
    model: agent.model ?? undefined,
    provider: agent.provider ?? undefined,
    systemPromptPreview: agent.systemPrompt?.slice(0, 200) ?? undefined,
    toolIds:
      agent.toolPolicy
      && typeof agent.toolPolicy === 'object'
      && !Array.isArray(agent.toolPolicy)
        ? Object.entries(agent.toolPolicy as Record<string, unknown>)
            .filter(([, enabled]) => enabled === true)
            .map(([toolId]) => toolId)
            .sort()
        : [],
    updatedAt: agent.updatedAt.toISOString(),
  })

const loadPersonalAssistantState = async (
  actorContext: AuthorizedActionContext & {
    actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
  },
) => {
  const userId = actorContext.actionContext.effectiveUserId ?? actorContext.actor.actorId
  const dmKey = `pa:${actorContext.tenant.organizationId}:${userId}`
  const channel = await prisma.channel.findUnique({
    where: { dmKey },
    select: {
      createdAt: true,
      id: true,
      label: true,
      organizationId: true,
      systemChannelType: true,
      teamId: true,
      type: true,
      updatedAt: true,
      visibility: true,
      team: {
        select: {
          name: true,
          project: {
            select: { id: true, name: true },
          },
        },
      },
      members: {
        where: { userId },
        select: { id: true },
        take: 1,
      },
      agentBindings: {
        orderBy: { createdAt: 'asc' },
        select: { agentId: true },
        take: 1,
      },
    },
  })

  if (
    !channel
    || channel.organizationId !== actorContext.tenant.organizationId
    || channel.members.length === 0
    || !isPersonalAssistantChannelType(channel.systemChannelType)
  ) {
    return null
  }

  const defaultThreadId = await ensureDefaultThread(prisma, channel.id)
  const thread = await prisma.thread.findUnique({
    where: { id: defaultThreadId },
    select: {
      channelId: true,
      createdAt: true,
      id: true,
      title: true,
      updatedAt: true,
    },
  })
  if (!thread) {
    return null
  }

  const agent = channel.agentBindings[0]?.agentId
    ? await prisma.agent.findUnique({
        where: { id: channel.agentBindings[0].agentId },
        select: {
          agentKind: true,
          bindings: {
            where: { channelId: channel.id },
            orderBy: { createdAt: 'asc' },
            select: { channelId: true },
          },
          createdAt: true,
          delegationMode: true,
          id: true,
          messages: {
            where: { threadId: thread.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
            take: 1,
          },
          model: true,
          name: true,
          provider: true,
          role: true,
          runs: {
            where: { threadId: thread.id },
            include: {
              toolCalls: {
                orderBy: { startedAt: 'desc' },
                select: {
                  endedAt: true,
                  startedAt: true,
                  toolName: true,
                },
                take: 1,
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          status: true,
          surfacePolicy: true,
          systemManaged: true,
          systemPrompt: true,
          toolPolicy: true,
          updatedAt: true,
        },
      })
    : null
  const latestRun = agent?.runs[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const latestMessage = agent?.messages[0]
  const isActiveRun =
    latestRun !== undefined
    && latestRun.status !== 'completed'
    && latestRun.status !== 'failed'
    && latestRun.status !== 'cancelled'
  const lastActivityAt =
    latestToolCall?.startedAt
    ?? latestMessage?.createdAt
    ?? latestRun?.createdAt
    ?? agent?.updatedAt
    ?? channel.updatedAt

  return PersonalAssistantStateResponseSchema.parse({
    agent: agent
      ? {
          id: parseAgentId(agent.id),
          name: agent.name,
          role: agent.role,
          status: agent.status,
          agentKind: agent.agentKind,
          systemManaged: agent.systemManaged,
          surfacePolicy: agent.surfacePolicy,
          delegationMode: agent.delegationMode,
          currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
          currentToolName:
            isActiveRun && latestToolCall?.endedAt === null ? latestToolCall.toolName : undefined,
          currentToolStartedAt:
            isActiveRun && latestToolCall?.endedAt === null
              ? latestToolCall.startedAt.toISOString()
              : undefined,
          lastActivityAt: lastActivityAt.toISOString(),
          parentAgentId: null,
          provider: agent.provider ?? undefined,
          model: agent.model ?? undefined,
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
          channelIds: agent.bindings.map((binding) => parseChannelId(binding.channelId)),
        }
      : null,
    channel: {
      id: parseChannelId(channel.id),
      label: channel.label,
      type: channel.type,
      systemChannelType: channel.systemChannelType,
      visibility: channel.visibility,
      organizationId: parseOrganizationId(channel.organizationId),
      projectId: parseProjectId(channel.team.project.id),
      projectName: channel.team.project.name,
      teamId: parseTeamId(channel.teamId),
      teamName: channel.team.name,
      defaultThreadId: parseThreadId(thread.id),
      unreadCount: 0,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    },
    instance: null,
    thread: ThreadRecordSchema.parse({
      id: parseThreadId(thread.id),
      channelId: parseChannelId(thread.channelId),
      title: thread.title ?? 'General',
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    }),
    ...(agent ? { configSummary: buildPersonalAssistantConfigSummary(agent) } : {}),
  })
}


const isAgentVisibleToUser = async (
  userId: string,
  organizationId: string,
  agentId: string,
): Promise<boolean> =>
  (await prisma.agent.count({
    where: {
      id: agentId,
      systemManaged: false,
      bindings: {
        some: {
          channel: {
            ...buildAccessibleChannelWhere({
              organizationId,
              userId,
            }),
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
          systemManaged: false,
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

const getVisibleChannel = async (
  userId: string,
  organizationId: string,
  channelId: string,
): Promise<{
  systemChannelType?: 'personal_assistant'
  type: string
  visibility: string
} | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      systemChannelType: true,
      type: true,
      organizationId: true,
      visibility: true,
      members: { where: { userId }, select: { id: true }, take: 1 },
    },
  })
  if (!channel) return null
  if (channel.organizationId !== organizationId) return null
  // Public channels are visible to all org members
  if (channel.visibility === 'public') {
    return {
      systemChannelType: channel.systemChannelType ?? undefined,
      type: channel.type,
      visibility: channel.visibility,
    }
  }
  // Protected and private channels require membership
  if (channel.members.length > 0) {
    return {
      systemChannelType: channel.systemChannelType ?? undefined,
      type: channel.type,
      visibility: channel.visibility,
    }
  }
  return null
}

const isChannelMember = async (userId: string, channelId: string): Promise<boolean> =>
  (await prisma.channelMember.count({ where: { userId, channelId } })) > 0

const getChannelIfMember = async (
  userId: string,
  organizationId: string,
  channelId: string,
): Promise<{
  systemChannelType?: 'personal_assistant'
  type: string
  visibility: string
} | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      systemChannelType: true,
      type: true,
      organizationId: true,
      visibility: true,
      members: { where: { userId }, select: { id: true }, take: 1 },
    },
  })
  if (!channel) return null
  if (channel.organizationId !== organizationId) return null
  if (channel.members.length === 0) return null
  return {
    systemChannelType: channel.systemChannelType ?? undefined,
    type: channel.type,
    visibility: channel.visibility,
  }
}

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
    !(await getVisibleChannel(
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

const parseBearerToken = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined
  }

  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}

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

const readWebhookApiKey = (request: FastifyRequest): string | undefined =>
  parseBearerToken(parseHeaderValue(request.headers['authorization'])) ??
  parseHeaderValue(request.headers['x-nessie-trigger-key'])

const isTimingSafeMatch = (left: string | undefined, right: string | undefined): boolean => {
  if (!left || !right) {
    return false
  }

  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

const canAccessChannelRealtimeEvent = async (input: {
  channelId: string
  organizationId: string
  userId: string
}): Promise<boolean> =>
  (await getVisibleChannel(input.userId, input.organizationId, input.channelId)) !== null

const createAgentVisibilityScope = (actorContext: AuthorizedActionContext) => ({
  includeAllOrgChannels: actorContext.actor.roles?.includes('owner') ?? false,
  organizationId: actorContext.tenant.organizationId,
  userId: actorContext.actor.actorId,
})

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
      if (await getVisibleChannel(userId, tenantOrganizationId, scope.channelId)) {
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

type RateLimitRule = {
  keyPrefix: string
  max: number
  windowMs: number
}

type RateLimitBucket = {
  count: number
  resetAt: number
}

const rateLimitBuckets = new Map<string, RateLimitBucket>()

const resolveRateLimitRule = (request: FastifyRequest): RateLimitRule | null => {
  const method = request.method.toUpperCase()
  const routePath = request.routeOptions.url ?? new URL(request.url, 'http://localhost').pathname

  if (method === 'POST' && (routePath === '/api/auth/session' || routePath === '/api/auth/bootstrap')) {
    return { keyPrefix: `${method}:${routePath}`, max: 10, windowMs: 10 * 60 * 1000 }
  }

  if (method === 'POST' && routePath === '/api/threads/:threadId/messages') {
    return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60 * 1000 }
  }

  if (routePath.startsWith('/api/agents') && ['DELETE', 'POST', 'PUT'].includes(method)) {
    return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60 * 1000 }
  }

  return null
}

const getRateLimitClientId = (request: FastifyRequest): string => {
  const forwardedFor = parseHeaderValue(request.headers['x-forwarded-for'])
  return forwardedFor?.split(',')[0]?.trim() || request.ip
}

const checkRateLimit = (request: FastifyRequest): { retryAfterSeconds: number } | null => {
  const rule = resolveRateLimitRule(request)
  if (!rule) {
    return null
  }

  const now = Date.now()
  const key = `${rule.keyPrefix}:${getRateLimitClientId(request)}`
  const existingBucket = rateLimitBuckets.get(key)
  const bucket =
    existingBucket && existingBucket.resetAt > now
      ? existingBucket
      : { count: 0, resetAt: now + rule.windowMs }

  bucket.count += 1
  rateLimitBuckets.set(key, bucket)

  if (bucket.count <= rule.max) {
    return null
  }

  return {
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

export const buildApp = async () => {
  const app = Fastify({
    logger: {
      // Redact the `token` query param (used by the WebSocket upgrade path
      // because the browser WS API cannot set headers) from access logs.
      redact: {
        paths: ['req.url'],
        censor: (value: unknown) =>
          typeof value === 'string'
            ? value.replace(/([?&])token=[^&]*/gi, '$1token=[REDACTED]')
            : value,
      },
    },
  })

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
        provider: (config.model.provider ?? 'openai') as 'openai' | 'minimax' | 'kimi',
      },
      apiUsageTracker,
    )
  } else {
    app.log.warn('No model API key configured — orchestrator, designer, and memory will fail')
  }

  const realtimeHub = await createRealtimeHub({
    canAccessChannelEvent: canAccessChannelRealtimeEvent,
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
  })

  const memoryPool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })
  const messageMemoryCaptureConfig = sharedModelClient
    ? { pool: memoryPool, modelClient: sharedModelClient }
    : null
  const thoughtService = sharedModelClient
    ? createThoughtService({
      pool: memoryPool,
      captureConfig: { pool: memoryPool, modelClient: sharedModelClient },
      searchConfig: { pool: memoryPool, modelClient: sharedModelClient },
    })
    : null

  if (config.mode !== 'local' && allowedCorsOrigins.size === 0) {
    app.log.warn('No CORS allowlist configured; browser cross-origin requests will be denied')
  }

  await app.register(cors, {
    credentials: true,
    origin: createCorsOriginChecker({
      allowedOrigins: allowedCorsOrigins,
      mode: config.mode,
    }),
  })
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
    const rateLimit = checkRateLimit(request)
    if (rateLimit) {
      reply.header('retry-after', String(rateLimit.retryAfterSeconds))
      sendApiError(reply, 429, 'RATE_LIMITED', 'Too many requests')
      return
    }

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

  // Readiness: unlike liveness, this fails (503) when the database is
  // unreachable or the worker has stopped heartbeating, so an orchestrator
  // can act on a degraded backend instead of seeing a permanent 200.
  app.get('/api/health/ready', { config: { public: true } }, async (_request, reply) => {
    const readiness = await getReadiness(prisma)
    const payload = createApiResponse(ReadinessResponseSchema.parse(readiness))
    return reply.code(readiness.ready ? 200 : 503).send(payload)
  })

  app.get('/api/ops/health', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const health = await getOpsHealth(prisma, actorContext.tenant.organizationId)
    return createApiResponse(OpsHealthResponseSchema.parse(health))
  })

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
          bootstrapUrl: '/bootstrap',
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
      // Do NOT null the state here — that would re-arm minting on the next
      // resolveBootstrapState() call. Leaving the expired state in place
      // forces an explicit process restart to recover.
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

  app.get('/api/auth/dev-login', { config: { public: true } }, async (request, reply) => {
    if (config.mode !== 'local') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available in local mode')
      return reply
    }

    const remoteIp = request.ip
    const isLoopback =
      remoteIp === '127.0.0.1'
      || remoteIp === '::1'
      || remoteIp === '::ffff:127.0.0.1'
    if (!isLoopback) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Dev login is only available from localhost')
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

  app.get('/api/personal-assistant', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    return createApiResponse(await loadPersonalAssistantState(actorContext))
  })

  app.post('/api/personal-assistant/bootstrap', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const bootstrap = await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId:
        actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
      userId: actorContext.actor.actorId,
    })
    const state = await loadPersonalAssistantState(actorContext)
    if (!state?.agent || !state.channel || !state.thread) {
      sendApiError(
        reply,
        500,
        'PERSONAL_ASSISTANT_BOOTSTRAP_FAILED',
        'Failed to load personal assistant state after bootstrap',
      )
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'personal_assistant.bootstrap' as Parameters<typeof emitAuditEvent>[1]['action'],
      outcome: 'success',
      resourceId: bootstrap.agentId,
      resourceType: 'agent',
    })

    return reply.code(200).send(
      createApiResponse(
        PersonalAssistantBootstrapResponseSchema.parse({
          agent: state.agent,
          channel: state.channel,
          configSummary: state.configSummary,
          instance: null,
          thread: state.thread,
        }),
      ),
    )
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
      teamId:
        body.teamId
        ?? actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? '00000000-0000-4000-8000-000000000003',
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
    const channel = await getChannelIfMember(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId)
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const body = parseInput(AddChannelMemberBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Personal Assistant DMs cannot be modified',
      )
      return reply
    }

    // If the channel is a DM, create a new group channel instead of mutating the DM
    if (channel.type === 'dm') {
      const group = await createGroupFromDm(prisma, {
        dmChannelId: channelId,
        newUserId: body.userId,
        currentUserId: actorContext.actor.actorId,
      })
      if (!group) {
        sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
        return reply
      }
      return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(group)))
    }

    const added = await addMemberToChannel(prisma, channelId, body.userId)
    if (!added) {
      sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
      return reply
    }
    return reply.code(204).send()
  })

  app.delete('/api/channels/:channelId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string }
    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      channelId,
    )
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Personal Assistant DMs cannot be modified',
      )
      return reply
    }

    await removeMemberFromChannel(prisma, channelId, userId)
    return reply.code(204).send()
  })

  app.post('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      channelId,
    )
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Calls are not available in the Personal Assistant DM',
      )
      return reply
    }

    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const memberCount = await prisma.channelMember.count({
      where: { channelId },
    })
    if (memberCount < 2) {
      sendApiError(reply, 400, 'CALL_REQUIRES_PARTICIPANTS', 'Calls require at least two channel members')
      return reply
    }

    try {
      const result = await createCall(prisma, channelId, actorContext.actor.actorId)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            roomId: result.roomId,
            startedBy: result.startedById,
          },
          event: 'call.started',
        },
      )

      return reply.code(201).send(createApiResponse(CallRecordSchema.parse(result)))
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_CALL_EXISTS') {
        sendApiError(reply, 409, 'ACTIVE_CALL_EXISTS', 'An active call already exists for this channel')
        return reply
      }

      throw error
    }
  })

  app.post('/api/calls/:callId/join', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { callId } = request.params as { callId: string }
    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        channelId: true,
        status: true,
      },
    })
    if (!call) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    if (
      !(await getChannelIfMember(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        call.channelId,
      ))
    ) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    try {
      const result = await joinCall(prisma, callId, actorContext.actor.actorId)

      const participant = result.participants.find((entry) => entry.userId === actorContext.actor.actorId)
      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            userId: actorContext.actor.actorId,
            displayName: participant?.displayName ?? actorContext.actor.actorId,
          },
          event: 'call.joined',
        },
      )

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      if (error instanceof Error && error.message === 'CALL_NOT_ACTIVE') {
        sendApiError(reply, 409, 'CALL_NOT_ACTIVE', 'Call is no longer active')
        return reply
      }

      throw error
    }
  })

  app.post('/api/calls/:callId/leave', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { callId } = request.params as { callId: string }
    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        channelId: true,
      },
    })
    if (!call) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    if (
      !(await getChannelIfMember(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        call.channelId,
      ))
    ) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    try {
      const result = await leaveCall(prisma, callId, actorContext.actor.actorId)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            userId: actorContext.actor.actorId,
          },
          event: 'call.left',
        },
      )

      if (result.status === 'ended') {
        await realtimeHub.publishWs(
          [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
          {
            data: {
              callId: result.id,
              channelId: result.channelId,
              endedAt: result.endedAt,
            },
            event: 'call.ended',
          },
        )
      }

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      throw error
    }
  })

  app.delete('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await getChannelIfMember(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const activeCall = await prisma.call.findFirst({
      where: {
        channelId,
        status: 'active',
      },
      select: {
        id: true,
      },
      orderBy: { startedAt: 'desc' },
    })
    if (!activeCall) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    try {
      const result = await endCall(prisma, activeCall.id)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            endedAt: result.endedAt,
          },
          event: 'call.ended',
        },
      )

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      throw error
    }
  })

  app.get('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await getVisibleChannel(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const result = await getActiveCallForChannel(prisma, channelId)
    return createApiResponse(result ? CallRecordSchema.parse(result) : null)
  })

  app.post('/api/dm/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { userId } = request.params as { userId: string }

    const channel = await findOrCreateDmChannel(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? '00000000-0000-4000-8000-000000000003',
      currentUserId: actorContext.actor.actorId,
      targetUserId: userId,
    })

    if (!channel) {
      sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
      return reply
    }

    return createApiResponse(ChannelRecordSchema.parse(channel))
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
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const agent = await createAgentRecord(prisma, {
      model: body.model,
      name: body.name,
      organizationId: actorContext.tenant.organizationId,
      parentAgentId: body.parentAgentId,
      projectId: actorContext.tenant.projectId,
      provider: body.provider,
      role: body.role ?? 'assistant',
      systemPrompt: body.systemPrompt,
      teamId: actorContext.tenant.teamId,
      toolPolicy: body.toolPolicy,
    })

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(agent)))
  })

  app.put('/api/agents/:agentId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(UpdateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const existingAgent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { systemManaged: true },
    })
    if (!existingAgent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    if (existingAgent.systemManaged && !requireOwner(actorContext, reply)) {
      return reply
    }

    const agent = await updateAgentRecord(prisma, agentId, body)
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
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

    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      body.channelId,
    )
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Agents cannot be bound to the Personal Assistant DM',
      )
      return reply
    }

    const { agentId } = request.params as { agentId: string }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

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
    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      channelId,
    )
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'The Personal Assistant DM binding is system managed',
      )
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const unbindDecision = await checkPolicy(prisma, actorContext, 'agent', 'bind', { agentId, channelId })
    if (!unbindDecision.allowed) {
      sendApiError(reply, 403, 'POLICY_DENIED', `Agent unbinding denied: ${unbindDecision.reasonCode}`)
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

  app.post('/api/triggers/webhook', { config: { public: true } }, async (request, reply) => {
    const apiKey = readWebhookApiKey(request)
    if (!apiKey) {
      sendApiError(reply, 401, 'WEBHOOK_API_KEY_REQUIRED', 'Webhook API key missing')
      return reply
    }

    if (!isJsonContentType(request)) {
      sendApiError(reply, 415, 'WEBHOOK_CONTENT_TYPE_INVALID', 'Webhook requests must use JSON')
      return reply
    }

    const candidateTriggers = await prisma.agentTrigger.findMany({
      where: {
        type: 'webhook',
      },
      select: {
        id: true,
        config: true,
      },
    })

    const matchedTrigger = candidateTriggers.find((candidate) => {
      const candidateApiKey =
        candidate.config &&
        typeof candidate.config === 'object' &&
        !Array.isArray(candidate.config) &&
        typeof (candidate.config as Record<string, unknown>)['apiKey'] === 'string'
          ? ((candidate.config as Record<string, unknown>)['apiKey'] as string)
          : undefined

      return isTimingSafeMatch(candidateApiKey, apiKey)
    })

    if (!matchedTrigger) {
      sendApiError(reply, 403, 'WEBHOOK_API_KEY_INVALID', 'Webhook API key is invalid')
      return reply
    }

    const dedupeKey =
      readFirstHeader(request, [
        'x-nessie-delivery-id',
        'x-github-delivery',
        'x-request-id',
      ]) ?? randomUUID()

    const dispatched = await dispatchAgentTrigger(prisma, {
      dedupeKey,
      payload: request.body,
      source: 'webhook',
      triggerId: matchedTrigger.id,
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

  app.put('/api/workflows/:workflowTemplateId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(UpdateWorkflowTemplateBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { workflowTemplateId } = request.params as { workflowTemplateId: string }
    let workflow
    try {
      workflow = await updateWorkflowTemplate(
        prisma,
        actorContext,
        workflowTemplateId,
        body,
      )
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
      message = await createMailboxMessage(prisma, actorContext.tenant.organizationId, {
        ...body,
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
      })
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

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
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
        role,
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

    return createApiResponse(ProjectRecordSchema.array().parse(projects.map((p) => ({
      id: p.id,
      name: p.name,
      organizationId: p.organizationId,
      memberCount: p.members.length,
      createdAt: p.createdAt.toISOString(),
    }))))
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

    return reply.code(201).send(createApiResponse(ProjectRecordSchema.parse({
      id: project.id,
      name: project.name,
      organizationId: project.organizationId,
      memberCount: 1,
      createdAt: project.createdAt.toISOString(),
    })))
  })

  app.patch('/api/projects/:projectId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const body = parseInput(UpdateProjectBodySchema, request.body, reply)
    if (!body) return reply

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      include: { members: { select: { userId: true, role: true } } },
    })
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: { name: body.name },
      include: { members: { select: { userId: true, role: true } } },
    })

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'project.updated' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'project',
      resourceId: updatedProject.id,
      outcome: 'success',
    })

    return createApiResponse(ProjectRecordSchema.parse({
      id: updatedProject.id,
      name: updatedProject.name,
      organizationId: updatedProject.organizationId,
      memberCount: updatedProject.members.length,
      createdAt: updatedProject.createdAt.toISOString(),
    }))
  })

  app.post('/api/projects/:projectId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project || project.organizationId !== actorContext.tenant.organizationId) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }

    await prisma.projectMember.create({
      data: {
        projectId,
        userId: body.userId,
        role,
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
      systemManaged: false,
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

    const project = await prisma.project.findUnique({ where: { id: body.projectId } })
    if (!project || project.organizationId !== actorContext.tenant.organizationId) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
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
    if (!requireOwner(actorContext, reply)) return reply

    const { teamId } = request.params as { teamId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { project: true },
    })
    if (!team || team.project.organizationId !== actorContext.tenant.organizationId) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
      return reply
    }

    await prisma.teamMember.create({
      data: {
        teamId,
        userId: body.userId,
        role,
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

    const project = await prisma.project.findUnique({ where: { id: body.projectId } })
    if (!project || project.organizationId !== body.organizationId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const projectMember = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: body.projectId,
          userId: actorContext.actor.actorId,
        },
      },
    })
    if (!projectMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const team = await prisma.team.findUnique({ where: { id: body.teamId } })
    if (!team || team.projectId !== body.projectId) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
      return reply
    }

    const teamMember = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: body.teamId,
          userId: actorContext.actor.actorId,
        },
      },
    })
    if (!teamMember) {
      sendApiError(reply, 403, 'NOT_A_MEMBER', 'Not a member of this project/team')
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
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    const query = request.query as { before?: string; limit?: string }
    const page = await listThreadMessages(prisma, thread.id, {
      before: query.before,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    })
    return createApiResponse(
      ThreadMessageRecordSchema.array().parse(page.data),
      page.meta,
    )
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
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
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

    if (messageMemoryCaptureConfig) {
      // Fire-and-forget: never block the message POST response on memory
      // capture. The handler comment downstream asserts orchestration "never
      // blocks this response" — keep that invariant here too.
      void captureUserMessageMemory(
        {
          channelId: thread.channel.id,
          content: result.message.content,
          memoryOrigin:
            thread.channel.systemChannelType === 'personal_assistant'
              ? 'personal_assistant_dm'
              : 'user_authored_workspace_message',
          messageId: result.message.id,
          organizationId: actorContext.tenant.organizationId,
          sourceAudience: thread.channel.type === 'dm' ? 'dm' : 'channel',
          threadId: thread.id,
          userId: actorContext.actor.actorId,
        },
        messageMemoryCaptureConfig,
      ).catch((err) =>
        request.log.error(
          { err, messageId: result.message.id },
          'capture_user_message_memory_failed',
        ),
      )
    }

    await realtimeHub.publishWs(
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
      {
        data: {
          agentId: undefined,
          contentPreview: result.message.content.slice(0, 200),
          messageId: result.message.id,
          role: result.message.role,
          threadId: parseThreadId(thread.id),
        },
        event: 'message.new',
      },
    )

    // Enqueue agent-engagement decision — durable, retryable, never blocks this
    // response. The try/catch ensures a transient queue-insert failure cannot
    // surface as a "failed" badge on an already-persisted user message.
    if (result.channelAgents.length > 0) {
      const orchestrationActorContext = isPersonalAssistantChannelType(
        thread.channel.systemChannelType,
      )
        ? withActionContext(actorContext, {
            effectiveUserId: parseUserId(actorContext.actor.actorId),
          })
        : actorContext

      try {
        await enqueueOrchestrateDecide(
          prisma,
          {
            actorContext: orchestrationActorContext,
            channelAgents: result.channelAgents,
            channelId: parseChannelId(thread.channel.id),
            content: body.content,
            messageId: result.message.id,
            role: result.message.role,
            threadId: parseThreadId(thread.id),
          },
          `orchestrate:${result.message.id}`,
        )
      } catch (err) {
        app.log.error(
          { err, messageId: result.message.id },
          '[orchestrate] failed to enqueue decide job — agent will not respond',
        )
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
          metadata:
            result.message.metadata
            && typeof result.message.metadata === 'object'
            && !Array.isArray(result.message.metadata)
              ? (result.message.metadata as Record<string, unknown>)
              : undefined,
        }),
      ),
    )
  })

  app.post('/api/threads/:threadId/read', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }

    await markThreadRead(prisma, {
      threadId: thread.id,
      userId: actorContext.actor.actorId,
    })

    return reply.code(200).send(createApiResponse({ ok: true }))
  })

  app.post('/api/threads/:threadId/messages/:messageId/reactions', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId, messageId } = request.params as { threadId: string; messageId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
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
      buildChannelRealtimeScopes({
        channelId: thread.channel.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: thread.channel.systemChannelType,
      }),
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
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
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

    // Register cleanup BEFORE awaiting addSseConnection so a half-open socket
    // is still torn down if the client disconnects mid-await.
    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    let streamConnection: Awaited<ReturnType<typeof realtimeHub.addSseConnection>> | null = null
    let socketClosed = false
    request.raw.on('close', () => {
      socketClosed = true
      clearInterval(keepAlive)
      if (streamConnection) {
        realtimeHub.removeSseConnection(streamConnection)
      }
      reply.raw.end()
    })

    try {
      streamConnection = await realtimeHub.addSseConnection(
        thread.id,
        reply.raw,
        lastEventId,
      )
      // If the socket closed during hydration the close handler fired with
      // streamConnection still null — remove now to avoid orphaning the
      // connection inside the hub.
      if (socketClosed) {
        realtimeHub.removeSseConnection(streamConnection)
      }
    } catch (err) {
      clearInterval(keepAlive)
      reply.raw.end()
      request.log.error({ err }, 'sse_setup_failed')
      return reply
    }
  })

  app.get('/api/agents/:agentId/status', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const status = await loadAgentStatus(prisma, agentId, { visibility })
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
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const activity = await loadAgentActivity(prisma, agentId, { visibility })
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
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentMessages(prisma, agentId, limit, offset, { visibility }))
  })

  app.get('/api/agents/:agentId/children', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
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
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadRunToolCalls(prisma, agentId, runId, { visibility }))
  })

  app.get('/api/activity', { websocket: true }, (socket, request) => {
    const actorContext = request.actorContext
    if (!actorContext) {
      socket.close(4001, 'Authentication required')
      return
    }

    const userId = actorContext.actor.actorId
    const tenantOrganizationId = actorContext.tenant.organizationId
    const wsConnection = realtimeHub.registerWsConnection({
      organizationId: tenantOrganizationId,
      userId,
      send: (message) => {
        sendJson(message)
      },
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
      const snapshot = await buildSnapshotForScopes(prisma, currentScopes, {
        visibility: createAgentVisibilityScope(actorContext),
      })

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

    const projectId = body.projectId ?? actorContext.tenant.projectId
    const teamId = body.teamId
      ?? actorContext.actionContext.teamId
      ?? actorContext.tenant.teamId
    const channelId = body.channelId
      ?? actorContext.actionContext.channelId
      ?? actorContext.tenant.channelId
      ?? undefined
    const captureAudience = resolveThoughtCaptureAudience(actorContext, {
      audienceType: body.audienceType,
      visibility: body.visibility,
      projectId,
      teamId,
      channelId,
    })
    if (!captureAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', captureAudience.error)
    }

    const result = await ts.capture({
      content: body.content,
      ownerId: actorContext.actor.actorId,
      ownerType: actorContext.actor.actorType,
      audienceType: captureAudience.audience.audienceType,
      audienceId: captureAudience.audience.audienceId,
      organizationId: actorContext.tenant.organizationId,
      projectId,
      teamId,
      channelId,
      threadId: body.threadId ?? undefined,
      userId: captureAudience.audience.audienceType === 'user'
        ? captureAudience.audience.audienceId
        : undefined,
      visibility: captureAudience.audience.visibility,
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

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(SearchThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    try {
      const results = await ts.search({
        query: body.query,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
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

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(RecordOutcomeBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    const hasAccess = await ts.verifyAccess({
      thoughtId: id,
      organizationId: actorContext.tenant.organizationId,
      requesterUserId: actorContext.actor.actorId,
      outputAudienceType: outputAudience.audience.audienceType,
      outputAudienceId: outputAudience.audience.audienceId,
    })
    if (!hasAccess) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    await ts.recordOutcome({
      thoughtId: id,
      organizationId: actorContext.tenant.organizationId,
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

    if (!requireUserActor(actorContext, reply)) {
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
      requesterUserId: actorContext.actor.actorId,
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

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const body = parseInput(LinkThoughtsBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const ts = requireThoughtService(reply)
    if (!ts) return reply

    const { id } = request.params as { id: string }
    const outputAudience = resolveThoughtOutputAudience(actorContext)
    if (!outputAudience.audience) {
      return sendApiError(reply, 400, 'INVALID_MEMORY_AUDIENCE', outputAudience.error)
    }

    // Verify both source and target are readable in the caller's current audience.
    const [sourceOk, targetOk] = await Promise.all([
      ts.verifyAccess({
        thoughtId: id,
        organizationId: actorContext.tenant.organizationId,
        requesterUserId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
      }),
      ts.verifyAccess({
        thoughtId: body.targetId,
        organizationId: actorContext.tenant.organizationId,
        requesterUserId: actorContext.actor.actorId,
        outputAudienceType: outputAudience.audience.audienceType,
        outputAudienceId: outputAudience.audience.audienceId,
      }),
    ])
    if (!sourceOk || !targetOk) {
      return sendApiError(reply, 404, 'THOUGHT_NOT_FOUND', 'Thought not found')
    }

    const linkId = await ts.link({
      sourceId: id,
      targetId: body.targetId,
      organizationId: actorContext.tenant.organizationId,
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

    // This endpoint calls the model in-process (not via the worker queue), so it
    // must consult the budget gate itself rather than rely on the worker gates.
    // It is an interactive owner action, so it counts as a human request.
    const budget = await checkBudget(
      prisma,
      {
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId: actorContext.tenant.teamId,
      },
      { isHuman: true },
    )
    if (!budget.allowed) {
      sendApiError(reply, 402, 'BUDGET_EXCEEDED', budget.reason ?? 'Monthly budget exceeded')
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
        ROLE_REQUIRED: { code: 403, message: 'You do not have the required approver role' },
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

  // ─── Tasks: human work distribution ─────────────────────────────────────

  const resolveTaskUserFilter = (
    value: string | undefined,
    actorContext: AuthorizedActionContext,
  ): string | undefined => {
    if (!value) return undefined
    return value === 'me' ? actorContext.actor.actorId : value
  }

  app.get('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const statusFilter = TaskStatusSchema.safeParse(query['status'])
    const tasks = await listTasks(prisma, actorContext.tenant.organizationId, {
      assigneeUserId: resolveTaskUserFilter(query['assignee'], actorContext),
      ownerUserId: resolveTaskUserFilter(query['owner'], actorContext),
      status: statusFilter.success ? statusFilter.data : undefined,
    })
    return createApiResponse(TaskRecordSchema.array().parse(tasks))
  })

  app.get('/api/tasks/assignees', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const users = await listAssignableUsers(prisma, actorContext.tenant.organizationId)
    return createApiResponse(AssignableUserSchema.array().parse(users))
  })

  app.post('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(CreateTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await createHumanTask(prisma, {
      organizationId: actorContext.tenant.organizationId,
      createdByUserId: actorContext.actor.actorId,
      title: body.title,
      purpose: body.purpose,
      assigneeUserId: body.assigneeUserId,
      ownerUserId: body.ownerUserId,
    })

    if ('error' in result) {
      sendApiError(reply, 400, result.error, 'Assignee or owner is not a member of this organization')
      return reply
    }

    return reply.code(201).send(createApiResponse(TaskRecordSchema.parse(result)))
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { taskId } = request.params as { taskId: string }
    const task = await getTask(prisma, taskId, actorContext.tenant.organizationId)
    if (!task) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(task))
  })

  app.post('/api/tasks/:taskId/assign', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(AssignTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await assignTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      assigneeUserId: body.assigneeUserId,
      actorId: actorContext.actor.actorId,
    })

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(reply, 400, result.error, 'Assignee is not a member of this organization')
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/transition', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(TransitionTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await transitionTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      status: body.status,
      actorId: actorContext.actor.actorId,
    })

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(
        reply,
        409,
        result.error,
        `Cannot transition task from ${result.from ?? 'unknown'} to ${body.status}`,
      )
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(result))
  })

  // ─── Phase 2: Token Ledger Routes ───────────────────────────────────────

  app.get('/api/ledger/tokens/summary', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

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
    if (!requireOwner(actorContext, reply)) return reply

    const estimate = await getMonthlyEstimate(prisma, actorContext.tenant.organizationId)
    return createApiResponse(estimate)
  })

  app.get('/api/ledger/tokens/pricing', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

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

  // Verify a budget scopeId belongs to the actor's organization before it can be
  // configured, so an owner cannot write a budget for another tenant's project/team.
  const budgetScopeBelongsToOrg = async (
    organizationId: string,
    scopeType: 'organization' | 'project' | 'team',
    scopeId: string,
  ): Promise<boolean> => {
    if (scopeType === 'organization') return scopeId === organizationId
    if (scopeType === 'project') {
      const project = await prisma.project.findFirst({
        where: { id: scopeId, organizationId },
        select: { id: true },
      })
      return Boolean(project)
    }
    const team = await prisma.team.findFirst({
      where: { id: scopeId, project: { organizationId } },
      select: { id: true },
    })
    return Boolean(team)
  }

  app.get('/api/ledger/budgets', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const statuses = await listBudgetStatuses(prisma, actorContext.tenant.organizationId)
    return createApiResponse(BudgetStatusResponseSchema.array().parse(statuses))
  })

  app.put('/api/ledger/budget', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(SetBudgetBodySchema, request.body, reply)
    if (!body) return reply

    if (!(await budgetScopeBelongsToOrg(actorContext.tenant.organizationId, body.scopeType, body.scopeId))) {
      sendApiError(reply, 400, 'INVALID_SCOPE', 'Budget scope does not belong to this organization')
      return reply
    }

    const status = await setBudgetConfig(prisma, {
      organizationId: actorContext.tenant.organizationId,
      ...body,
    })
    return createApiResponse(BudgetStatusResponseSchema.parse(status))
  })

  app.delete('/api/ledger/budget', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = request.query as { scopeType?: string; scopeId?: string }
    const parsedScope = BudgetScopeTypeSchema.safeParse(query.scopeType)
    const parsedScopeId = SetBudgetBodySchema.shape.scopeId.safeParse(query.scopeId)
    if (!parsedScope.success || !parsedScopeId.success) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'scopeType and a valid scopeId (UUID) are required')
      return reply
    }

    const removed = await deleteBudget(
      prisma,
      actorContext.tenant.organizationId,
      parsedScope.data,
      parsedScopeId.data,
    )
    if (!removed) {
      sendApiError(reply, 404, 'NOT_FOUND', 'No budget configured for that scope')
      return reply
    }
    return reply.code(204).send()
  })

  // ─── Inference control plane routes ─────────────────────────────────────
  registerInferenceControlPlaneRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── MCP universal connector routes (Slice C) ──────────────────────────
  // NOTE: `oauthSecretStore` is intentionally omitted until a KMS-backed
  // implementation lands. `registerMcpRoutes` itself enforces the production
  // guard — it will throw at startup when NODE_ENV=production so a misconfigured
  // deploy fails loud instead of silently dropping OAuth tokens.
  registerMcpRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  registerToolBundleRoutes(app, {
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

  // In local mode, start the worker in-process so agents always work
  if (config.mode === 'local') {
    const { startWorker } = await import('@nessie/worker')
    await startWorker()
    console.log('[api] embedded worker started (local mode)')
  }

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApiServer()
}
