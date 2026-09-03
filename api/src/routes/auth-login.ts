import type { FastifyInstance } from 'fastify'
import { MeResponseSchema, type UoaSessionIdentity } from '@nessie/schemas'
import type { Prisma } from '@prisma/client'

import { verifyPassword } from '../auth/password.js'
import { verifySessionToken, type SessionTokenClaims } from '../auth/session.js'
import { LoginRequestSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
  LOCAL_AUTH_PROVIDER_ID,
  resolveConfiguredAuthProvider,
} from '../services/auth.js'
import { exchangeExternalAuthCode } from '../services/external-auth.js'
import { resolveExternalTeamSelection } from '../services/identity-display.js'
import { syncUoaProductAccountLinks } from '../services/integrations.js'
import { attemptPersonalAssistantAvatar } from '../services/personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import { attemptGlobalAgentsBootstrap } from '../services/global-agents.js'
import { RefreshTokenIssuanceError } from '../services/refresh-token.js'
import { confirmUoaDirectServiceAccess } from '../services/uoa-billing-client.js'
import { loadSessionUserByEmail, loadSessionUserById } from '../services/users.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import {
  rejectTeamIdentity,
  rejectTeamRecovery,
  rejectTeamTarget,
  verifyRecoveryBearer,
} from './auth-login-recovery.js'
import {
  assertUoaRecoveryAccountLink,
  claimUoaRecoveryAccountLink,
  UoaRecoveryAccountLinkError,
} from '../services/uoa-recovery-link.js'
import { UoaUnrecognizedRoleError } from '../services/uoa-roles.js'
import { resolveUoaTeamContext } from '../services/team-context.js'
import { UoaSubjectConflictError } from '../services/team-principal.js'
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

  app.post('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(LoginRequestSchema, request.body, reply)
    if (!body) return reply
    // expectedTeam is a strict AUTHENTICATED discriminant for
    // team-switch reauthorization, never an extra claim of an ordinary
    // login. It is valid ONLY as a complete providerId=uoa code exchange
    // accompanied by a current Bearer Nessie session, so every other shape —
    // password login, a local provider, an incomplete exchange — is refused
    // at the top, before any password verification or upstream path runs.
    let recoveryClaims: SessionTokenClaims | null = null
    if (body.expectedTeam) {
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
        rejectTeamRecovery(reply)
        return reply
      }
      recoveryClaims = await verifyRecoveryBearer(request, {
        authSecret,
        getAuthorizationToken,
        prisma,
      })
      if (!recoveryClaims) {
        rejectTeamRecovery(reply)
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
        const verifiedUoaTeam = uoaSession
          ? resolveExternalTeamSelection(uoaSession.identity.team)
          : undefined
        if (
          uoaSession
          && (!verifiedUoaTeam?.organizationId || !verifiedUoaTeam.teamId)
        ) {
          throw new Error(
            'UnlikeOtherAI did not return an exact user, organization, and team.',
          )
        }
        if (uoaSession && verifiedUoaTeam?.organizationId && verifiedUoaTeam.teamId) {
          // Recovery discriminants run FIRST — immediately after parsing the
          // returned identity/team and before the billing confirm (a
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
          if (recoveryClaims && body.expectedTeam) {
          if (
            uoaSession.identity.externalSubject !== recoveryClaims.uoaIdentity?.subject
          ) {
            rejectTeamIdentity(reply)
            return reply
          }
          const returnedEpoch = uoaSession.identity.uoaTokenVersion
          // UOA must return a valid epoch for a credential Nessie is about to
          // sign into a renewal; anything else is refused before billing.
          if (
            !Number.isSafeInteger(returnedEpoch)
            || returnedEpoch < 0
          ) {
            rejectTeamIdentity(reply)
            return reply
          }
          // Non-null by the bearer guard above: the bearer's credential
          // epoch is the recovery's minimum acceptable UOA epoch.
          const bearerEpoch = recoveryClaims.uoaIdentity!.tokenVersion!
          if (returnedEpoch < bearerEpoch) {
            rejectTeamIdentity(reply)
            return reply
          }
          if (
            verifiedUoaTeam.organizationId !== body.expectedTeam.organizationId
            || verifiedUoaTeam.teamId !== body.expectedTeam.teamId
          ) {
            rejectTeamTarget(reply)
            return reply
          }
          // Pre-billing fence: the durable first-party Nessie account link
          // in the bearer's EXACT SOURCE organization claim (never an
          // ambient org lookup) must still be linked to the returned subject
          // with a valid epoch no newer than the returned one — a statement
          // about the bearer's own credential, valid even when the recovery
          // targets a DIFFERENT org (cross-org reauthorization). This is a
          // read-only proof under the user-session lock; the authoritative
          // fence is the conditional claim on the TARGET org's link inside
          // the single recovery transaction below.
          try {
            await assertUoaRecoveryAccountLink(prisma, {
              identity: {
                organizationId: verifiedUoaTeam.organizationId,
                subject: uoaSession.identity.externalSubject,
                teamId: verifiedUoaTeam.teamId,
                tokenVersion: returnedEpoch,
              },
              localOrganizationId: recoveryClaims.org,
              returnedTokenVersion: returnedEpoch,
              subject: uoaSession.identity.externalSubject,
              userId: recoveryClaims.sub,
            })
          } catch (error) {
            if (error instanceof UoaRecoveryAccountLinkError) {
              rejectTeamIdentity(reply)
              return reply
            }
            throw error
          }
          }
          await confirmUoaDirectServiceAccess({
            organizationId: verifiedUoaTeam.organizationId,
            teamId: verifiedUoaTeam.teamId,
            tokenVersion: uoaSession.identity.uoaTokenVersion,
            userId: uoaSession.identity.externalSubject,
          })
        }

        let context
        try {
          context = await resolveUoaTeamContext(prisma, {
            avatarUrl: identity.avatarUrl,
            displayName: identity.displayName,
            email: identity.email,
            // UOA principals are keyed by the stable subject; generic OIDC
            // providers carry no uoaSession and keep email keying.
            uoaSub: uoaSession?.identity.externalSubject,
            // Recovery binds the context to the exact principal the bearer
            // proved: the resolver never looks up, remaps, or creates a user
            // by email (or subject claim) for this call. The bearer's own
            // organization claim is the recovery's local-org scope, and the
            // authoritative account-link fence is the conditional claim inside
            // the SINGLE recovery transaction — after the exact
            // external-team lock, before the target existing-or-create
            // branch and every membership write, with the claimed row lock
            // held to commit. A refusal aborts the whole transaction after
            // billing ran at most once, with no target, membership, session,
            // context, or cookie write.
            ...(recoveryClaims && uoaSession
              ? {
                  // The claim fences the TARGET organization's link (created
                  // there on a first entry — a cross-org reauthorization is
                  // legitimate under the per-UOA-org model); the resolver
                  // passes the org it resolved from the verified team
                  // claim. The bearer's own org claim below is only the
                  // legacy fallback scope and the pre-billing assert's home.
                  recoveryLinkClaim: (
                    transaction: Prisma.TransactionClient,
                    targetOrganizationId: string,
                  ) =>
                    claimUoaRecoveryAccountLink(transaction, {
                      identity: {
                        organizationId: verifiedUoaTeam!.organizationId!,
                        subject: uoaSession.identity.externalSubject,
                        teamId: verifiedUoaTeam!.teamId!,
                        tokenVersion: uoaSession.identity.uoaTokenVersion,
                      },
                      localOrganizationId: targetOrganizationId,
                      returnedTokenVersion: uoaSession.identity.uoaTokenVersion,
                      subject: uoaSession.identity.externalSubject,
                      userId: recoveryClaims.sub,
                      // Recovery keeps the legacy metadata byte-shape: only
                      // directory entries, never pending invitation data.
                      teamDirectory: uoaSession.teamDirectory?.entries,
                    }),
                  existingUserId: recoveryClaims.sub,
                  expectedLocalOrganizationId: recoveryClaims.org,
                }
              : {}),
            team: identity.team,
          })
        } catch (error) {
          if (error instanceof UoaRecoveryAccountLinkError) {
            rejectTeamIdentity(reply)
            return reply
          }
          throw error
        }
        if (!context) {
          // A recovery reaching here with the bearer's exact organization
          // missing is an identity refusal, not a provisioning failure.
          if (recoveryClaims) {
            rejectTeamIdentity(reply)
            return reply
          }
          sendApiError(reply, 500, 'NO_DEFAULT_ORG', 'No organization configured for SSO provisioning')
          return reply
        }
        if (recoveryClaims && context.userId !== recoveryClaims.sub) {
          // Unreachable by construction (the recovery seam resolves exactly
          // that id); fail closed rather than ever issue for another user.
          rejectTeamIdentity(reply)
          return reply
        }
        // The team context already resolved the one principal (by subject
        // on the UOA path, by the proven bearer on recovery) and re-synced
        // the profile mirror from this exchange's verified claims — load the
        // session user by that id, never by email, and never repair the
        // stored name here.
        const sessionUser = await loadSessionUserById(prisma, context.userId)
        if (!sessionUser) {
          sendApiError(reply, 500, 'USER_NOT_FOUND', 'Failed to load authenticated user')
          return reply
        }


        let uoaSessionIdentity: UoaSessionIdentity | undefined
        if (uoaSession && verifiedUoaTeam?.organizationId && verifiedUoaTeam.teamId) {
          const uoaIdentity = uoaSession.identity
          // Recovery refreshed exactly the Nessie link inside the resolver
          // transaction (epoch + directory/active tuple, atomically with the
          // membership upserts). Running the generic all-products sync here
          // could upsert an UNRELATED first-party link and strand an
          // otherwise committed recovery, so it stays an ordinary-login step.
          if (!recoveryClaims) {
            await syncUoaProductAccountLinks(prisma, {
              email: identity.email,
              externalSubject: uoaIdentity.externalSubject,
              organizationId: context.organizationId,
              uoaTokenVersion: uoaIdentity.uoaTokenVersion,
              userId: context.userId,
              team: uoaIdentity.team,
              teamDirectory: uoaSession.teamDirectory,
            })
          }
          uoaSessionIdentity = {
            organizationId: verifiedUoaTeam.organizationId,
            subject: uoaIdentity.externalSubject,
            teamId: verifiedUoaTeam.teamId,
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
        await attemptGlobalAgentsBootstrap(
          prisma,
          {
            organizationId: context.organizationId,
            teamId: context.teamId,
            userId: context.userId,
          },
          (error) => request.log.error({ err: error }, 'global_agent_bootstrap_failed'),
        )
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
        if (error instanceof UoaUnrecognizedRoleError) {
          // UOA claimed a role this deployment does not model. There is no
          // local membership row that grants nothing, so the only fail-closed
          // answer is no session at all — never a coerced `member`.
          sendApiError(reply, 403, 'UOA_ROLE_UNRECOGNIZED', error.message)
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
    const session = await buildLocalSession(
      user.id,
      [primaryOrganizationMember.role],
      undefined,
      { userAgent: request.headers['user-agent'] ?? null },
    )
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
    await attemptGlobalAgentsBootstrap(
      prisma,
      {
        organizationId: actorContext.tenant.organizationId,
        teamId: actorContext.tenant.teamId!,
        userId: user.id,
      },
      (error) => request.log.error({ err: error }, 'global_agent_bootstrap_failed'),
    )
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
