import Fastify, { type FastifyInstance } from 'fastify'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { createRequestHelpers } from '../../src/lib/request-helpers.js'
import { sendApiError } from '../../src/lib/api.js'
import type { RouteDeps } from '../../src/routes/types.js'
import { TenantStore } from './tenant-store.js'

/**
 * Two fully-separate tenants. Every conformance case seeds a resource under
 * `orgA` and drives the request as a legitimate **owner of `orgB`** — the
 * strongest realistic attacker (full privileges, wrong tenant). If a handler is
 * correctly scoped, orgB can never see or mutate orgA's row.
 */
export const IDS = {
  orgA: '00000000-0000-4000-8000-0000000000a0',
  orgB: '00000000-0000-4000-8000-0000000000b0',
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
  projectA: '00000000-0000-4000-8000-0000000000a2',
  projectB: '00000000-0000-4000-8000-0000000000b2',
  teamA: '00000000-0000-4000-8000-0000000000a3',
  teamB: '00000000-0000-4000-8000-0000000000b3',
  channelA: '00000000-0000-4000-8000-0000000000a4',
  agentA: '00000000-0000-4000-8000-0000000000a5',
  threadA: '00000000-0000-4000-8000-0000000000a6',
  triggerA: '00000000-0000-4000-8000-0000000000a7',
  approvalA: '00000000-0000-4000-8000-0000000000a8',
  auditA: '00000000-0000-4000-8000-0000000000a9',
  taskA: '00000000-0000-4000-8000-0000000000aa',
  spaceA: '00000000-0000-4000-8000-0000000000ab',
  pageA: '00000000-0000-4000-8000-0000000000ac',
  iterationA: '00000000-0000-4000-8000-0000000000ad',
  connectionA: '00000000-0000-4000-8000-0000000000ae',
  mcpInstanceA: '00000000-0000-4000-8000-0000000000af',
  workflowInstallA: '00000000-0000-4000-8000-0000000000c0',
} as const

type Role = 'owner' | 'admin' | 'member'

export const actorContext = (
  overrides: {
    organizationId?: string
    userId?: string
    projectId?: string
    teamId?: string
    roles?: Role[]
    actorType?: 'user' | 'agent'
  } = {},
): AuthorizedActionContext => ({
  actor: {
    actorType: overrides.actorType ?? 'user',
    actorId: overrides.userId ?? IDS.userB,
    roles: overrides.roles ?? ['owner'],
  },
  tenant: {
    organizationId: parseOrganizationId(overrides.organizationId ?? IDS.orgB),
    projectId: parseProjectId(overrides.projectId ?? IDS.projectB),
    teamId: parseTeamId(overrides.teamId ?? IDS.teamB),
  },
  actionContext: {
    requestId: 'req-conformance',
    teamId: parseTeamId(overrides.teamId ?? IDS.teamB),
  },
})

/** The canonical cross-tenant attacker: a full owner of the *other* org. */
export const foreignOwner = (): AuthorizedActionContext => actorContext()

/** A legitimate owner of orgA — used for positive-control assertions. */
export const localOwner = (): AuthorizedActionContext =>
  actorContext({ organizationId: IDS.orgA, userId: IDS.userA, projectId: IDS.projectA, teamId: IDS.teamA })

/**
 * Seed the baseline tenancy graph so the foreign owner is a *fully privileged*
 * member of their own org (orgB) — org owner, team owner, project member. This
 * is what makes a leak detectable: with these rows present, the ONLY thing that
 * can stop orgB's owner from managing an orgA resource is a correct
 * `organizationId` scope check. Remove that check in a handler and the
 * membership fallbacks would grant access, turning the conformance case red.
 */
export const seedTenants = (store: TenantStore): void => {
  store.seed('organizationMember', [
    { id: `${IDS.userA}-om`, organizationId: IDS.orgA, userId: IDS.userA, role: 'owner' },
    { id: `${IDS.userB}-om`, organizationId: IDS.orgB, userId: IDS.userB, role: 'owner' },
  ])
  store.seed('teamMember', [
    { id: `${IDS.userA}-tm`, teamId: IDS.teamA, userId: IDS.userA, role: 'owner' },
    { id: `${IDS.userB}-tm`, teamId: IDS.teamB, userId: IDS.userB, role: 'owner' },
  ])
  store.seed('projectMember', [
    { id: `${IDS.userA}-pm`, projectId: IDS.projectA, userId: IDS.userA },
    { id: `${IDS.userB}-pm`, projectId: IDS.projectB, userId: IDS.userB },
  ])
  store.seed('user', [
    { id: IDS.userA, superAdmin: false },
    { id: IDS.userB, superAdmin: false },
  ])
}

/**
 * Assemble a `RouteDeps` object backed by the tenant store. The real
 * `createRequestHelpers` runs against the fake prisma so accessibility gates
 * (`isAgentAccessibleToActor`, `getChannelIfMember`, `isTriggerAccessibleToActor`,
 * …) exercise their genuine `organizationId` filters. `requireActorContext`,
 * `requireOwner`, and `requireUserActor` mirror the production guards exactly.
 */
export const buildDeps = (store: TenantStore): RouteDeps => {
  const prisma = store.client
  const helpers = createRequestHelpers(prisma)

  const requireActorContext = (
    request: { actorContext?: AuthorizedActionContext | null },
    reply: unknown,
  ): AuthorizedActionContext | null => {
    if (request.actorContext) return request.actorContext
    sendApiError(reply as never, 401, 'AUTH_REQUIRED', 'Authentication required')
    return null
  }

  const requireOwner = (ctx: AuthorizedActionContext, reply: unknown): boolean => {
    if (ctx.actor.roles?.includes('owner')) return true
    sendApiError(reply as never, 403, 'FORBIDDEN', 'Owner access required')
    return false
  }

  const requireUserActor = (ctx: AuthorizedActionContext, reply: unknown): boolean => {
    if (ctx.actor.actorType === 'user') return true
    sendApiError(reply as never, 403, 'FORBIDDEN', 'User actor required')
    return false
  }

  const requireSuperAdmin = async (
    _ctx: AuthorizedActionContext,
    reply: unknown,
  ): Promise<boolean> => {
    sendApiError(reply as never, 403, 'FORBIDDEN', 'Super-admin access required')
    return false
  }

  const realtimeHub = {
    publishWs: async () => undefined,
    publish: async () => undefined,
    close: async () => undefined,
  }

  return {
    prisma,
    ...helpers,
    config: { mode: 'local' },
    authSecret: 'test-conformance-secret',
    requireActorContext,
    requireOwner,
    requireUserActor,
    requireSuperAdmin,
    realtimeHub,
    sharedModelClient: null,
    messageMemoryCaptureConfig: null,
    thoughtService: null,
    deepSignalMcpIdentity: null,
    fileService: {},
  } as unknown as RouteDeps
}

/**
 * Register a route module on a fresh Fastify instance and pin the authenticated
 * actor for the whole app. Handlers read `request.actorContext` exactly as they
 * do in production (set by the auth preHandler there, by this hook here).
 */
export const makeApp = (
  register: (app: FastifyInstance, deps: RouteDeps) => void,
  store: TenantStore,
  actor: AuthorizedActionContext,
): FastifyInstance => {
  const app = Fastify({ logger: false })
  app.decorateRequest('actorContext', null)
  app.addHook('onRequest', (request, _reply, done) => {
    ;(request as { actorContext: AuthorizedActionContext }).actorContext = actor
    done()
  })
  register(app, buildDeps(store))
  return app
}
