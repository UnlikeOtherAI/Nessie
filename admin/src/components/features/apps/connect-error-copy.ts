/**
 * What went wrong, and what we say about it.
 *
 * Two jobs that belong together and nowhere else: turning whatever was thrown
 * into one of a closed set of codes, and turning a code into the sentence a
 * person reads. They sit apart from the state machine because they are the
 * flow's *vocabulary* — the panel and the machine both need it, and neither
 * owns it.
 *
 * Every sentence names the person's next action. An error that answers no
 * question was cut rather than softened.
 */

export const CONNECT_ERROR_CODES = [
  'AUTH_CANCELLED',
  'AUTH_EXPIRED',
  'AUTH_FAILED',
  'SERVER_UNREACHABLE',
  'SERVER_INVALID',
  'MCP_INITIALIZATION_FAILED',
  'CAPABILITY_DISCOVERY_FAILED',
  'OAUTH_DISCOVERY_FAILED',
  'CLIENT_APPROVAL_REQUIRED',
  'CLIENT_REGISTRATION_FAILED',
  'CONNECTION_FAILED',
] as const

export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number]

export const isConnectErrorCode = (value: unknown): value is ConnectErrorCode =>
  typeof value === 'string'
  && (CONNECT_ERROR_CODES as readonly string[]).includes(value)

/**
 * A thrown value, classified.
 *
 * The API client throws a bare `Error` carrying only the server's message, so a
 * code is read from an error object that has one and otherwise from a message
 * that *is* exactly a code. Anything else is `CONNECTION_FAILED` with the raw
 * text kept as technical detail — guessing a specific cause from prose would
 * put a confident wrong sentence in front of a person.
 */
export const normalizeConnectError = (
  error: unknown,
): { code: ConnectErrorCode; detail: string | null } => {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown }
    if (isConnectErrorCode(candidate.code)) {
      const message = typeof candidate.message === 'string' ? candidate.message : null
      return { code: candidate.code, detail: message }
    }
  }
  const message = error instanceof Error ? error.message : null
  if (isConnectErrorCode(message)) return { code: message, detail: null }
  return { code: 'CONNECTION_FAILED', detail: message }
}

export type ConnectErrorPresentation = {
  message: string
  /**
   * Whether a retry button belongs beside the sentence. Null where the sentence
   * already names a different action, so the panel does not offer two.
   */
  retryLabel: string | null
  /** Cancelling is a legitimate choice, so it is information, not damage. */
  tone: 'danger' | 'info'
}

export type ConnectErrorNames = {
  appName: string
  /** The sign-in provider's name when it differs from the app's. */
  providerName?: string | null
}

export const connectErrorPresentation = (
  code: ConnectErrorCode,
  names: ConnectErrorNames,
): ConnectErrorPresentation => {
  const app = names.appName
  const provider = names.providerName ?? names.appName
  const tryAgain = 'Try again'

  switch (code) {
    case 'AUTH_CANCELLED':
      return {
        message:
          'Connection cancelled. Nothing was connected — you can start again '
          + 'whenever you’re ready.',
        retryLabel: tryAgain,
        tone: 'info',
      }
    case 'AUTH_EXPIRED':
      return {
        message:
          'The sign-in session expired before it finished. Try again — it only '
          + 'takes a moment.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'AUTH_FAILED':
      return {
        message:
          `${provider} didn’t accept the sign-in. Check that you approved `
          + 'the access request, then try again.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'SERVER_UNREACHABLE':
      // Deliberately "the server listed for Jira", never "Jira's server". A
      // catalogue name is the record author's claim, and most entries are
      // community listings pointing at somebody else's gateway — the store's
      // "Jira" is `waystation.ai/jira/mcp`. Saying "we couldn't reach Jira's
      // server" reports an outage at Atlassian on the strength of a stranger's
      // listing, and sends the reader to check the wrong thing.
      return {
        message:
          `We couldn’t reach the server listed for ${app}. Try again — if it `
          + 'keeps happening, that listing may be out of date.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'SERVER_INVALID':
      return {
        message:
          'That address doesn’t look like an app server. Check the link and '
          + 'try again.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'MCP_INITIALIZATION_FAILED':
      return {
        message:
          `We reached ${app}, but it didn’t answer correctly. This is usually `
          + 'a problem on the app’s side — try again later.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'CAPABILITY_DISCOVERY_FAILED':
      return {
        message:
          `${app} connected, but we couldn’t load what it can do. Try `
          + 'refreshing capabilities from the Manage menu.',
        // The sentence sends the person to the Manage menu; a retry button here
        // would offer a second, different action for one problem.
        retryLabel: null,
        tone: 'danger',
      }
    case 'OAUTH_DISCOVERY_FAILED':
      return {
        message:
          `We couldn’t work out how to sign in to ${app} automatically. If you `
          + 'run this server, check its sign-in configuration; otherwise try '
          + 'again later.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'CLIENT_REGISTRATION_FAILED':
      return {
        message:
          `We couldn’t register Nessie with ${app} to sign you in. Try again — `
          + 'if it persists, ask the app’s provider whether third-party '
          + 'sign-in is enabled.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
    case 'CLIENT_APPROVAL_REQUIRED':
      return {
        message:
          `${app} only accepts pre-approved sign-in clients. Ask its provider `
          + 'to approve Nessie, then connect again.',
        retryLabel: null,
        tone: 'danger',
      }
    case 'CONNECTION_FAILED':
      return {
        message:
          `Something went wrong while connecting to ${app}. Nothing was saved. `
          + 'Try again.',
        retryLabel: tryAgain,
        tone: 'danger',
      }
  }
}
