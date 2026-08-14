import type { AuthSessionState, SessionPayload } from '@nessie/client-core'
import { claimPendingExternalAuth, clearPendingExternalAuthMatching } from './pkce'
import type {
  ExternalAuthCallbackEnvelope,
} from '../providers/external-auth-callback'

export type ExternalAuthCompletionResult =
  | { claimed: true; message: string; outcome: 'cancelled'; returnPath: string }
  | { claimed: true; outcome: 'completed'; returnPath: string }
  | { claimed: true; message: string; outcome: 'failed'; returnPath: string }
  | { claimed: false; outcome: 'ignored' }
  | { claimed: false; message: string; outcome: 'state-mismatch'; returnPath: string }

const DEFAULT_RETURN_PATH = '/channels'
const LOGIN_PATH = '/login'
const MAX_RETURN_PATH_LENGTH = 512
const FAILURE_MESSAGE = 'The external sign-in could not be completed.'
const VERIFICATION_MESSAGE = 'The external sign-in callback could not be verified.'

const safeReturnPath = (value: string | undefined, fallback: string): string =>
  value
  && value.startsWith('/')
  && !value.startsWith('//')
  && !/[\\\u0000-\u001f\u007f]/.test(value)
  && value.length <= MAX_RETURN_PATH_LENGTH
    ? value
    : fallback

export type ExternalAuthRecoveryExchange = (
  input: {
    code: string
    codeVerifier: string
    providerId: string
    redirectUri: string
    theme?: string
  },
  expectedWorkspace: { organizationId: string; teamId: string },
) => Promise<SessionPayload>

/**
 * One terminal callback path for web, Tauri, iOS and Android. Claiming the
 * matching pending record happens synchronously before any exchange, so an OS
 * replay cannot exchange the same code twice. A stale state does not consume a
 * newer launch.
 */
export const completeExternalAuthCallback = async (input: {
  envelope: ExternalAuthCallbackEnvelope
  login: (input: {
    code: string
    codeVerifier: string
    providerId: string
    redirectUri: string
    theme?: string
  }) => Promise<void>
  recoveryExchange: ExternalAuthRecoveryExchange
  waitForSessionReady: () => Promise<AuthSessionState>
}): Promise<ExternalAuthCompletionResult> => {
  const { callback, redirectUri } = input.envelope
  const claim = claimPendingExternalAuth(callback.state)
  if (claim.kind === 'absent') return { claimed: false, outcome: 'ignored' }

  const successPath = safeReturnPath(claim.pending.returnPath, DEFAULT_RETURN_PATH)
  const failurePath = claim.pending.targetWorkspace ? successPath : LOGIN_PATH
  if (claim.kind === 'state-mismatch') {
    return {
      claimed: false,
      message: VERIFICATION_MESSAGE,
      outcome: 'state-mismatch',
      returnPath: failurePath,
    }
  }

  const finish = <T extends ExternalAuthCompletionResult>(result: T): T => {
    clearPendingExternalAuthMatching(claim.pending.state)
    return result
  }

  if (callback.kind === 'cancelled') {
    return finish({
      claimed: true,
      message: 'Sign-in was cancelled.',
      outcome: 'cancelled',
      returnPath: failurePath,
    })
  }
  if (callback.kind === 'provider-error') {
    return finish({
      claimed: true, message: FAILURE_MESSAGE, outcome: 'failed', returnPath: failurePath,
    })
  }

  const pending = claim.pending
  const exchangeInput = {
    code: callback.code,
    codeVerifier: pending.codeVerifier,
    providerId: pending.providerId,
    redirectUri,
    ...(pending.theme ? { theme: pending.theme } : {}),
  }

  try {
    if (pending.targetWorkspace) {
      // Restoration owns the source session proof. Never turn a targeted
      // callback into an ordinary login while that proof is still loading or
      // after it has resolved unauthenticated.
      if (await input.waitForSessionReady() !== 'authenticated') {
        return finish({
          claimed: true, message: FAILURE_MESSAGE, outcome: 'failed', returnPath: failurePath,
        })
      }
      await input.recoveryExchange(exchangeInput, pending.targetWorkspace)
    } else {
      await input.login(exchangeInput)
    }
  } catch {
    return finish({
      claimed: true, message: FAILURE_MESSAGE, outcome: 'failed', returnPath: failurePath,
    })
  }

  return finish({ claimed: true, outcome: 'completed', returnPath: successPath })
}
