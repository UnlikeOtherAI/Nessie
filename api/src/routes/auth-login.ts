import type { FastifyInstance } from 'fastify'
import { MeResponseSchema, type UoaSessionIdentity } from '@nessie/schemas'

import { verifyPassword } from '../auth/password.js'
import {
  isSessionTokenRevoked,
  verifySessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { LoginRequestSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
  LOCAL_AUTH_PROVIDER_ID,
  resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { exchangeExternalAuthCode } from '../services/external-auth.js'
import { resolveExternalWorkspaceSelection } from '../services/identity-display.js'
import { syncUoaProductAccountLinks } from '../services/integrations.js'
import { attemptPersonalAssistantAvatar } from '../services/personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import { RefreshTokenIssuanceError } from '../services/refresh-token.js'
import { confirmUoaDirectServiceAccess } from '../services/uoa-billing-client.js'
import { loadSessionUserByEmail, loadSessionUserById } from '../services/users.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import { resolveUoaWorkspaceContext } from '../services/workspace-context.js'
import { UoaSubjectConflictError } from '../services/workspace-principal.js'
import type { IssueRefreshCookie } from './auth-shared.js'
import type { RouteDeps } from './types.js'

export const registerAuthLoginRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
  issueRefreshCookie: IssueRefreshCookie,
): void => {
  const {
    authSecret,
    config,
    prisma,
    buildLocalSession,
    buildSessionForUser,
    getAuthorizationToken,
    rateLimiter,
  } = deps

  const rejectWorkspaceTarget = (
    reply: Parameters<typeof sendApiError>[0],
  ): void => {
    sendApiError(
      reply,
      401,
      'WORKSPACE_TARGET_MISMATCH',
      'The renewed session is not on the requested workspace. Try switching again.',
    )
  }

  const rejectWorkspaceIdentity = (
    reply: Parameters<typeof sendApiError>[0],
  ): void => {
    sendApiError(
      reply,
      401,
      'WORKSPACE_IDENTITY_MISMATCH',
      'This sign-in belongs to a different account. Try switching again.',
    )
  }

  const rejectWorkspaceRecovery = rejectWorkspaceIdentity

  // Verify the Bearer Nessie session an expectedWorkspace discriminant must
  // accompany: a live, unrevoked UOA access token for an existing local user
  // with an immutable UOA identity bound. Returns null on any refusal — every
  // caller rejects before any upstream exchange or local write.
  const verifyRecoveryBearer = async (
    request: Parameters<typeof getAuthorizationToken>[0],
  ): Promise<SessionTokenClaims | null> => {
    const bearer = getAuthorizationToken(request)
    if (!bearer) {
      return null
    }
    const verification = verifySessionToken(bearer, authSecret)
    if (!verification.ok) {
      return null
    }
    if (verification.claims.providerType !== 'uoa' || !verification.claims.uoaIdentity) {
      return null
    }
    if (verification.claims.providerId !== 'uoa') {
      return null
    }
    const sessionUser = await prisma.user.findUnique({
      where: { id: verification.claims.sub },
      select: { tokenVersion: true },
    })
    if (!sessionUser || isSessionTokenRevoked(verification.claims, sessionUser.tokenVersion)) {
      return null
    }
    return verification.claims
  }

  app.post('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LoginRequestSchema, request.body, reply)
    if (!body) return reply
    // expectedWorkspace is a strict AUTHENTICATED discriminant for
    // workspace-switch reauthorization, never an extra claim of an ordinary
    // login. It is valid ONLY as a complete providerId=uoa code exchange
    // accompanied by a current Bearer Nessie session, so every other shape —
    // password login, a local provider, an incomplete exchange — is refused
    // at the top, before any password verification or upstream path runs.
    let recoveryClaims: SessionTokenClaims | null = null
    if (body.expectedWorkspace) {
      const isUoaExchange = Boolean(
        body.providerId === 'uoa'
        && body.code
        && body.codeVerifier
        && body.redirectUri
      )
      const provider = isUoaExchange
        ? resolveConfiguredAuthProvider(config, body.providerId as string)
        : null
      if (!provider || provider.type !== 'uoa') {
        rejectWorkspaceRecovery(reply)
        return reply
      }
      recoveryClaims = await verifyRecoveryBearer(request)
      if (!recoveryClaims) {
        rejectWorkspaceRecovery(reply)
        return reply
      }
    }
    // Brute-force guard: per-IP always, per-account (email, hashed) for the
    // password path. SSO code exchanges key only off the client IP — the
    // upstream identity is not known until the exchange succeeds.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        { bucket: RATE_LIMIT_BUCKETS.loginIp, rule: config.api.rateLimit.loginIp },
        request,
        reply,
        {
          account: {
            bucket: RATE_LIMIT_BUCKETS.loginAccount,
            rule: config.api.rateLimit.loginAccount,
          },
          // Normalize exactly like the account lookup
          // (loadSessionUserByEmail trims + lowercases) so case/whitespace
          // variants of one email share a single counter instead of each
          // getting a fresh bucket against the same account.
          accountIdentity: body.email?.trim().toLowerCase() ?? null,
        },
      ))
    ) {
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
        const exchange = await exchangeExternalAuthCode(provider, {
          code: body.code,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
          theme: body.theme,
        })
        const { identity } = exchange
        const uoaSession = provider.type === 'uoa' ? exchange.uoaSession : undefined
        if (provider.type === 'uoa' && !uoaSession) {
          throw new Error('UnlikeOtherAI did not return a renewable session proof.')
        }
        const verifiedUoaWorkspace = uoaSession
          ? resolveExternalWorkspaceSelection(uoaSession.identity.workspace)
          : undefined
        if (
          uoaSession
          && (!verifiedUoaWorkspace?.organizationId || !verifiedUoaWorkspace.teamId)
        ) {
          throw new Error(
            'UnlikeOtherAI did not return an exact user, organization, and team.',
          )
        }
        if (uoaSession && verifiedUoaWorkspace?.organizationId && verifiedUoaWorkspace.teamId) {
          // Recovery discriminants run FIRST — immediately after parsing the
          // returned identity/workspace and before the billing confirm (a
          // POST side effect) or any local mutation (provisioning,
          // ProductAccountLink sync, session/family issuance, Set-Cookie).
          // Identity is the UOA SUBJECT, never the exchanged email: the same
          // subject with a changed email keeps the bearer's exact local user,
          // while a different subject (Alice's bearer, Bob's callback) is an
          // identity refusal. The returned epoch may legitimately be newer
          // than the bearer's (another device re-authenticated first), so a
          // newer returned epoch is accepted — but a REGRESSED epoch is
          // refused here, before any side effect, rather than being left to
          // the ProductAccountLink sync below.
          if (recoveryClaims && body.expectedWorkspace) {
            if (
              uoaSession.identity.externalSubject !== recoveryClaims.uoaIdentity?.subject
            ) {
              rejectWorkspaceIdentity(reply)
              return reply
            }
            const returnedEpoch = uoaSession.identity.uoaTokenVersion
            const bearerEpoch = recoveryClaims.uoaIdentity?.tokenVersion
            if (typeof bearerEpoch === 'number' && returnedEpoch < bearerEpoch) {
              rejectWorkspaceIdentity(reply)
              return reply
            }
            if (
              verifiedUoaWorkspace.organizationId !== body.expectedWorkspace.organizationId
              || verifiedUoaWorkspace.teamId !== body.expectedWorkspace.teamId
            ) {
              rejectWorkspaceTarget(reply)
              return reply
            }
          }
          await confirmUoaDirectServiceAccess({
            organizationId: verifiedUoaWorkspace.organizationId,
            teamId: verifiedUoaWorkspace.teamId,
            tokenVersion: uoaSession.identity.uoaTokenVersion,
            userId: uoaSession.identity.externalSubject,
          })
        }

        const context = await resolveUoaWorkspaceContext(prisma, {
          avatarUrl: identity.avatarUrl,
          displayName: identity.displayName,
          email: identity.email,
          // UOA principals are keyed by the stable subject; generic OIDC
          // providers carry no uoaSession and keep email keying.
          uoaSub: uoaSession?.identity.externalSubject,
          // Recovery binds the context to the exact principal the bearer
          // proved: the resolver never looks up, remaps, or creates a user by
          // email (or subject claim) for this call.
          ...(recoveryClaims ? { existingUserId: recoveryClaims.sub } : {}),
          workspace: identity.workspace,
        })
        if (!context) {
          sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
          return reply
        }
        if (recoveryClaims && context.userId !== recoveryClaims.sub) {
          // Unreachable by construction (the recovery seam resolves exactly
          // that id); fail closed rather than ever issue for another user.
          rejectWorkspaceIdentity(reply)
          return reply
        }
        // The workspace context already resolved the one principal (by subject
        // on the UOA path, by the proven bearer on recovery) — load the
        // session user by that id, never by email.
        let sessionUser = await loadSessionUserById(prisma, context.userId)
        if (!sessionUser) {
          sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
          return reply
        }
        if (
          !recoveryClaims
          &&
          sessionUser.displayName === sessionUser.email
          && identity.displayName !== sessionUser.displayName
        ) {
          await prisma.user.update({
            where: { id: sessionUser.id },
            data: { displayName: identity.displayName },
          })
          sessionUser = await loadSessionUserById(prisma, context.userId)
          if (!sessionUser) {
            sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
            return reply
          }
        }

        let uoaSessionIdentity: UoaSessionIdentity | undefined
        if (uoaSession && verifiedUoaWorkspace?.organizationId && verifiedUoaWorkspace.teamId) {
          const uoaIdentity = uoaSession.identity
          await syncUoaProductAccountLinks(prisma, {
            email: identity.email,
            externalSubject: uoaIdentity.externalSubject,
            organizationId: context.organizationId,
            uoaTokenVersion: uoaIdentity.uoaTokenVersion,
            userId: context.userId,
            workspace: uoaIdentity.workspace,
            workspaceDirectory: uoaSession.workspaceDirectory,
          })
          uoaSessionIdentity = {
            organizationId: verifiedUoaWorkspace.organizationId,
            subject: uoaIdentity.externalSubject,
            teamId: verifiedUoaWorkspace.teamId,
            tokenVersion: uoaIdentity.uoaTokenVersion,
          }
        }

        const session = await buildSessionForUser({
          organizationId: context.organizationId,
          projectId: context.projectId,
          providerId: provider.providerId,
          providerType: provider.type,
          roles: [context.orgRole],
          teamId: context.teamId,
          uoaIdentity: uoaSessionIdentity,
          userId: context.userId,
        })
        const verification = verifySessionToken(session.token, authSecret)
        if (!verification.ok) {
          sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue external auth session')
          return reply
        }
        const actorContext = createActorContextFromClaims(verification.claims)
        await ensurePersonalAssistantBootstrap(prisma, {
          organizationId: context.organizationId,
          teamId: context.teamId,
          userId: context.userId,
        })
        await attemptPersonalAssistantAvatar({
          actorContext,
          config: deps.config.model,
          fileService: deps.fileService,
          ledgerIdentity: deps.ledgerIdentity,
          modelClient: deps.sharedModelClient,
          organizationId: context.organizationId,
          prisma,
        })
        await issueRefreshCookie(request, reply, {
          userId: sessionUser.id,
          organizationId: verification.claims.org,
          sessionId: session.sessionId,
          providerId: verification.claims.providerId,
          providerType: verification.claims.providerType,
          ...(uoaSession && verification.claims.uoaIdentity
            ? {
                uoaSession: {
                  exchange: uoaSession,
                  identity: verification.claims.uoaIdentity,
                },
              }
            : {}),
        })
        return createApiResponse({
          token: session.token,
          me: MeResponseSchema.parse(
            await buildMeResponse(prisma, sessionUser, verification.claims, config),
          ),
        })
      } catch (error) {
        if (error instanceof UoaSubjectConflictError) {
          // Identity conflict: the asserted email belongs to a Nessie account
          // bound to a different UOA subject. Fail closed — never take the
          // account over, never create a duplicate. Operator resolution only.
          sendApiError(reply, 409, 'UOA_IDENTITY_CONFLICT', error.message)
          return reply
        }
        sendApiError(
          reply,
          401,
          'EXTERNAL_AUTH_FAILED',
          error instanceof Error ? error.message : 'External authentication failed',
        )
        return reply
      }
    }

    // Local-password authentication exists only for `local` installs (the
    // bootstrap owner + `nessie local up`). Anywhere else identity belongs to
    // the configured SSO provider, so the password branch is refused
    // server-side rather than merely hidden from the login screen.
    if (config.mode !== 'local') {
      sendApiError(
        reply,
        403,
        'PASSWORD_AUTH_DISABLED',
        'Password sign-in is disabled on this deployment. Sign in with your identity provider.',
      )
      return reply
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
    const session = await buildLocalSession(user.id, [primaryOrganizationMember.role])
    const verification = verifySessionToken(session.token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 500, 'TOKEN_INVALID', 'Failed to issue session')
      return reply
    }
    const actorContext = createActorContextFromClaims(verification.claims)
    await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId!,
      userId: user.id,
    })
    await attemptPersonalAssistantAvatar({
      actorContext,
      config: deps.config.model,
      fileService: deps.fileService,
      ledgerIdentity: deps.ledgerIdentity,
      modelClient: deps.sharedModelClient,
      organizationId: actorContext.tenant.organizationId,
      prisma,
    })
    try {
      await issueRefreshCookie(request, reply, {
        userId: user.id,
        organizationId: verification.claims.org,
        sessionId: session.sessionId,
        providerId: verification.claims.providerId,
        providerType: verification.claims.providerType,
        expectedPasswordHash: user.passwordHash,
      })
    } catch (error) {
      if (error instanceof RefreshTokenIssuanceError) {
        sendApiError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password')
        return reply
      }
      throw error
    }
    return createApiResponse({
      token: session.token,
      me: MeResponseSchema.parse(
        await buildMeResponse(prisma, user, verification.claims, config),
      ),
    })
  })
}
