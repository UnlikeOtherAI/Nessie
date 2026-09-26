import { deriveConnectionStatus } from '@nessie/mcp-manage'
import type { AccountStatus, McpServerLifecycleState } from '@nessie/schemas'

/**
 * The one status mapper behind every account row (plan §6.9, §10.1). Each
 * store keeps its own status and health reason; this turns each of them into
 * one of the five words, a sentence that says what to do, and the code of the
 * one step that fixes it — so a mailbox, a Google account and an AI plan that
 * all stopped for the same reason read the same way.
 *
 * Sentences name the service a person connected ("sign in to Google again"),
 * never a protocol or the vendor behind a Nessie service, and never a
 * provider's own error text: a mail server or an upstream API chooses that
 * text, and it is untrusted input.
 */

const connected: AccountStatus = { remedy: 'none', sentence: 'Connected.', word: 'connected' }

/** A Google, Microsoft or Slack account. */
export const commsAccountStatus = (
  status: 'active' | 'needs_reauthorization' | 'disconnected' | 'error',
  serviceName: string,
): AccountStatus => {
  switch (status) {
    case 'active':
      return connected
    case 'needs_reauthorization':
      return {
        remedy: 'reconnect',
        sentence: `Stopped: sign in to ${serviceName} again.`,
        word: 'needs_attention',
      }
    case 'disconnected':
      return {
        remedy: 'reconnect',
        sentence: 'Disconnected. Nothing is read from it until you connect it again.',
        word: 'turned_off',
      }
    case 'error':
      return {
        remedy: 'resync',
        sentence: 'Stopped after an error. Resync it, and reconnect it if the error comes back.',
        word: 'error',
      }
  }
}

/** A mailbox at another email provider, personal or a team's shared one. */
export const mailboxAccountStatus = (
  status: 'active' | 'needs_reauthorization' | 'disabled',
): AccountStatus => {
  switch (status) {
    case 'active':
      return connected
    case 'needs_reauthorization':
      return {
        remedy: 'reconnect',
        sentence:
          'Stopped: the mail server refused the password. Disconnect it and connect it again with the current one.',
        word: 'needs_attention',
      }
    case 'disabled':
      return {
        remedy: 'none',
        sentence: 'Turned off. Agents cannot reach it.',
        word: 'turned_off',
      }
  }
}

/** A Jira, Linear, Trello or GitHub account that projects sync through. */
export const ticketsAccountStatus = (
  status: 'active' | 'needs_reauthorization' | 'revoked',
  serviceName: string,
): AccountStatus => {
  switch (status) {
    case 'active':
      return connected
    case 'needs_reauthorization':
      return {
        remedy: 'reconnect',
        sentence: `Stopped: sign in to ${serviceName} again. Boards that sync through it are paused.`,
        word: 'needs_attention',
      }
    case 'revoked':
      return {
        remedy: 'reconnect',
        sentence: `${serviceName} withdrew this access. Connect it again to keep boards syncing.`,
        word: 'turned_off',
      }
  }
}

/**
 * A personal AI plan. The health reason is the more specific fact — a plan can
 * be `active` and out of quota — so it decides first, and the status decides
 * only when the reason is `ok`.
 */
export const aiPlanAccountStatus = (
  input: {
    healthReason:
      | 'ok'
      | 'needs_reauthorization'
      | 'provider_rejected'
      | 'quota_exhausted'
      | 'owner_inactive'
      | 'vault_unavailable'
    status: 'active' | 'needs_reauthorization' | 'disconnected' | 'error'
  },
  serviceName: string,
): AccountStatus => {
  if (input.status === 'disconnected') {
    return {
      remedy: 'reconnect',
      sentence: 'Disconnected. Link it again for your agents to run on it.',
      word: 'turned_off',
    }
  }
  switch (input.healthReason) {
    case 'needs_reauthorization':
      return {
        remedy: 'reconnect',
        sentence: `Stopped: link your ${serviceName} plan again.`,
        word: 'needs_attention',
      }
    case 'quota_exhausted':
      return {
        remedy: 'wait',
        sentence: `Out of quota at ${serviceName}. Agents that run on it wait until the plan renews.`,
        word: 'needs_attention',
      }
    case 'provider_rejected':
      return {
        remedy: 'reconnect',
        sentence: `${serviceName} refused this plan. Check the plan at ${serviceName}, then link it again.`,
        word: 'error',
      }
    case 'owner_inactive':
      return {
        remedy: 'ask',
        sentence: 'Paused while its owner’s account is deactivated.',
        word: 'turned_off',
      }
    case 'vault_unavailable':
      return {
        remedy: 'ask',
        sentence: 'Nessie cannot reach the store that keeps this plan’s key. Ask an administrator.',
        word: 'error',
      }
    case 'ok':
      break
  }
  switch (input.status) {
    case 'active':
      return connected
    case 'needs_reauthorization':
      return {
        remedy: 'reconnect',
        sentence: `Stopped: link your ${serviceName} plan again.`,
        word: 'needs_attention',
      }
    case 'error':
      return {
        remedy: 'reconnect',
        sentence: 'Stopped after an error. Link it again.',
        word: 'error',
      }
  }
}

/**
 * A cloud browser account at any level. The health reason is a machine code
 * the connection records (`auth_failed`, `unreachable`, `disabled_by_owner`).
 */
export const browserAccountStatus = (input: {
  healthReason: string | null
  status: 'active' | 'needs_attention' | 'disabled'
}): AccountStatus => {
  if (input.status === 'active') return connected
  if (input.status === 'disabled') {
    return { remedy: 'ask', sentence: 'Turned off by an owner.', word: 'turned_off' }
  }
  if (input.healthReason === 'unreachable') {
    return {
      remedy: 'wait',
      sentence: 'The cloud browser service could not be reached. It is tried again on its own.',
      word: 'needs_attention',
    }
  }
  return {
    remedy: 'replace_key',
    sentence: 'Stopped: the cloud browser key was refused. Replace the key.',
    word: 'needs_attention',
  }
}

/**
 * A person's own app connection. The lifecycle goes through the App Store's
 * own `deriveConnectionStatus`, so the app page and this row can never read a
 * connection differently.
 */
export const appAccountStatus = (
  lifecycleState: McpServerLifecycleState,
  appName: string,
): AccountStatus => {
  const status = deriveConnectionStatus(lifecycleState)
  switch (status) {
    case 'connected':
      return connected
    case 'connecting':
      return {
        remedy: 'finish_setup',
        sentence: `Not finished: finish signing in to ${appName}.`,
        word: 'not_finished',
      }
    case 'expired':
      return {
        remedy: 'reconnect',
        sentence: `Stopped: sign in to ${appName} again.`,
        word: 'needs_attention',
      }
    case 'error':
      return {
        remedy: 'reconnect',
        sentence: `Something went wrong while connecting to ${appName}. Reconnect it.`,
        word: 'error',
      }
    case 'disabled':
      return { remedy: 'none', sentence: 'Turned off.', word: 'turned_off' }
  }
}
