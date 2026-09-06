import { useCallback } from 'react'
import type { MeResponse } from '@nessie/schemas'
import {
  captureTeamSessionSource,
  classifyTeamSessionPayload,
  createAuthSessionApi,
  createSessionMutationCoordinator,
  type ExpectedTeamTarget,
  type ExternalLoginInput,
  type RecoverTeamSessionInput,
  type SessionPayload,
  type SwitchContextInput,
  type SwitchUoaTeamInput,
} from '@nessie/client-core'
import { IMPORTED_SESSION_SCOPE_MESSAGE } from '../lib/imported-session-policy'
import type { AmbientRefreshGateHost } from './ambient-refresh-gate-host'

type UseTeamSessionRecoveryInput = {
  ambientRefreshGate: AmbientRefreshGateHost
  authApi: ReturnType<typeof createAuthSessionApi>
  // The bearer that a pasted debug dump installed, if the live one is it. A
  // dump carries no refresh credential, so it can never be re-scoped.
  importedSessionTokenRef: { current: string | null }
  meRef: { current: MeResponse | null }
  sessionMutations: ReturnType<typeof createSessionMutationCoordinator>
  tokenRef: { current: string | null }
}

/**
 * The three entry points that move a session to a different UOA team: the
 * external-auth recovery exchange and the two switches. All of them queue
 * through the one session coordinator and read the live bearer/identity from
 * the provider's refs, which is why the refs are parameters rather than
 * closures — nothing here holds session state of its own.
 */
export const useTeamSessionRecovery = ({
  ambientRefreshGate,
  authApi,
  importedSessionTokenRef,
  meRef,
  sessionMutations,
  tokenRef,
}: UseTeamSessionRecoveryInput) => {
  const recoveryExchange = useCallback(async (
    input: ExternalLoginInput,
    expectedTeam: ExpectedTeamTarget,
  ): Promise<SessionPayload> => {
    if (input.providerId !== 'uoa') {
      throw new Error('Team session recovery is only supported for the UOA provider.')
    }
    // The bearer AND the source session are captured lexically inside the
    // queued thunk — immediately before the request is sent — so the
    // classification compares against the session that is current when the
    // mutation actually runs, not when it was enqueued. The guard closure
    // reads that same lexical binding for BOTH the direct payload and the one
    // opaque-refresh winner, whose raw response carries no request-local
    // proof — nothing is ever attached to the payload itself.
    //
    // This binding is per CALL, deliberately. Hoisting it to a ref would let
    // a second concurrent recovery overwrite the source the first one is
    // about to classify against — the exact race this shape avoids.
    let capturedSource: ReturnType<typeof captureTeamSessionSource> = null
    const recovered = sessionMutations.runGuarded(
      () => {
        const currentToken = tokenRef.current
        if (typeof currentToken !== 'string' || currentToken.length === 0) {
          throw new Error('Team session recovery requires an active session.')
        }
        const currentMe = meRef.current
        if (!currentMe) {
          throw new Error('Team session recovery requires an active session.')
        }
        const source = captureTeamSessionSource(currentMe)
        if (!source) {
          throw new Error('Team session recovery is only supported for the UOA provider.')
        }
        capturedSource = source
        const recoveryInput: RecoverTeamSessionInput = {
          code: input.code,
          codeVerifier: input.codeVerifier,
          expectedTeam,
          providerId: 'uoa',
          redirectUri: input.redirectUri,
          ...(input.theme === undefined ? {} : { theme: input.theme }),
        }
        return authApi.recoverTeamSession(currentToken, recoveryInput)
      },
      (payload) => {
        // Defense in depth behind the API's pre-issuance rejection, as a
        // three-way classification against the lexically captured source:
        // exact target succeeds; the preserved source session is applied but
        // the recovery rejects as a non-switch; anything else is foreign. If
        // the thunk never captured a source the guard fails closed (foreign).
        if (!capturedSource) {
          return {
            kind: 'foreign',
            message: 'The renewed session could not be verified. Try switching again.',
          }
        }
        return classifyTeamSessionPayload(payload, expectedTeam, capturedSource)
      },
    )
    const payload = await recovered
    // A valid explicit recovery — exact target applied — reopens ambient
    // refresh; a rejected non-switch or foreign payload never does.
    ambientRefreshGate.reopen()
    return payload
  }, [ambientRefreshGate, authApi, meRef, sessionMutations, tokenRef])

  const assertReScopable = useCallback((): void => {
    if (tokenRef.current && importedSessionTokenRef.current === tokenRef.current) {
      throw new Error(IMPORTED_SESSION_SCOPE_MESSAGE)
    }
  }, [importedSessionTokenRef, tokenRef])

  const switchContext = useCallback(async (input: SwitchContextInput): Promise<void> => {
    assertReScopable()
    await sessionMutations.run(() => authApi.switchContext(tokenRef.current, input))
  }, [assertReScopable, authApi, sessionMutations, tokenRef])

  const switchUoaTeam = useCallback(async (input: SwitchUoaTeamInput): Promise<void> => {
    assertReScopable()
    await sessionMutations.run(() => authApi.switchUoaTeam(tokenRef.current, input))
  }, [assertReScopable, authApi, sessionMutations, tokenRef])

  return { recoveryExchange, switchContext, switchUoaTeam }
}
