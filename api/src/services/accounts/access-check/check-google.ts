import type { Prisma, PrismaClient } from '@prisma/client'
import { GMAIL_SEARCH_TOOL_ID } from '@nessie/runtime'
import {
  GOOGLE_CAPABILITIES,
  GoogleCapabilityIdSchema,
  getGoogleCapability,
  usableCapabilities,
  type AccessCheckStep,
  type AccountRecord,
  type AuthorizedActionContext,
  type GoogleCapabilityId,
} from '@nessie/schemas'
import {
  CommsCredentialCoordinatorError,
  hasStandingSendAuthorization,
  selectUserGoogleConnection,
} from '@nessie/team-admin'

import { googleToolsState } from '../account-grants-read.js'
import type { AccountViewer } from '../account-sources.js'
import {
  accountHref,
  accountStep,
  agentToolsHref,
  fail,
  pass,
  placementStep,
  skip,
  warn,
  type CheckAgent,
  type CheckContext,
} from './check-context.js'
import { policyStep } from './check-policy.js'

/**
 * A Google account acts for the person asking, in that person's own
 * conversations (`docs/standards/google-workspace.md`). The provider step is
 * the capability catalog read against what Google granted and what is blocked
 * here; the context step is `selectUserGoogleConnection` — the selection a
 * tool call makes — for the person the run would act as; the send step is
 * `hasStandingSendAuthorization` with the requester the worker passes it.
 */

const strings = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const SELECTION_REFUSAL: Record<string, string> = {
  AMBIGUOUS_ACCOUNT: 'More than one of your Google accounts could answer, so the agent has to be told which.',
  CAPABILITY_BLOCKED: 'You blocked that here, so it is refused even though Google allows it.',
  CONNECTION_NOT_FOUND: 'The person asking has no Google account connected that could answer.',
  NEEDS_REAUTHORIZATION: 'Google needs you to sign in again before it answers.',
  SCOPE_MISSING: 'Google has not granted what it needs.',
}

export const checkGoogle = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  actor: AuthorizedActionContext,
  input: { account: AccountRecord; agent: CheckAgent; connectionId: string; context: CheckContext },
): Promise<AccessCheckStep[]> => {
  const { account, agent, connectionId, context } = input
  const row = await prisma.commsConnection.findFirstOrThrow({
    select: { disabledCapabilities: true, grantedScopes: true },
    where: { id: connectionId, organizationId: viewer.organizationId, ownerUserId: viewer.userId },
  })
  const disabled = strings(row.disabledCapabilities).filter(
    (entry): entry is GoogleCapabilityId => GoogleCapabilityIdSchema.safeParse(entry).success,
  )
  const usable = usableCapabilities({ disabledCapabilities: disabled, grantedScopes: strings(row.grantedScopes) })
  const steps: AccessCheckStep[] = [accountStep(account, true)]

  const labels = GOOGLE_CAPABILITIES.filter((capability) => usable.includes(capability.id))
    .map((capability) => capability.label.toLowerCase())
  steps.push(usable.length > 0
    ? pass('provider', 'Provider permits it', 'capabilities_granted', `Google allows: ${labels.join(', ')}.`)
    : fail('provider', 'Provider permits it', 'nothing_granted', 'Google has granted nothing an agent can use.',
      { code: 'grant_capability', href: accountHref(account), label: 'Choose what Google may allow' }))

  steps.push(pass('agent', 'Agent allowed', 'requester_rule',
    `Any agent you talk to may use your Google account in your own conversations, ${agent.name} included.`))

  steps.push(googleToolsState(agent.toolPolicy) === 'on'
    ? pass('tools', 'Agent’s own tools', 'google_tools_on', `${agent.name}’s Google tools are on.`)
    : fail('tools', 'Agent’s own tools', 'google_tools_off', `${agent.name}’s Google tools are off.`,
      viewer.isOwner
        ? { code: 'turn_on_tools', href: agentToolsHref(agent.id), label: 'Turn on its Google tools' }
        : { code: 'ask_owner', href: null, label: 'Ask an organisation owner to turn them on' }))

  const placement = placementStep(agent, context)
  if (placement) {
    steps.push(placement)
  } else if (!context.effectiveUserId) {
    steps.push(fail('context', 'Asked from here', 'nobody_asking',
      'Nobody is asking, so no one’s Google account is reached.', null))
  } else {
    // The capability a read would name: reading mail when it is allowed, or
    // whatever this account does allow.
    const capability: GoogleCapabilityId | undefined = usable.includes('gmail.read') ? 'gmail.read' : usable[0]
    if (!capability) {
      steps.push(skip('context', 'Asked from here', 'after_earlier_steps', 'Checked once Google allows something.'))
    } else {
      try {
        const selected = await selectUserGoogleConnection(prisma, {
          capabilityId: capability,
          organizationId: viewer.organizationId,
          requiredScopes: getGoogleCapability(capability).scopes,
          userId: context.effectiveUserId,
        })
        steps.push(selected.id === connectionId
          ? pass('context', 'Asked from here', 'this_account',
            'You are asking, so this account answers. What it reads from it is shown only to you.')
          : warn('context', 'Asked from here', 'another_account',
            'Your requests here use another of your Google accounts.'))
      } catch (error) {
        if (!(error instanceof CommsCredentialCoordinatorError)) throw error
        const sentence = SELECTION_REFUSAL[error.code] ?? 'This account cannot answer here.'
        steps.push(error.code === 'AMBIGUOUS_ACCOUNT'
          ? warn('context', 'Asked from here', 'ambiguous_account', sentence)
          : fail('context', 'Asked from here', error.code.toLowerCase(), sentence,
            { code: 'reconnect', href: accountHref(account), label: 'Open the account' }))
      }
    }
  }

  // A standing permission applies only when the run's effective user is the
  // asking person — the direct conversation of a system agent — and never
  // to a run nobody is asking in (`hasStandingSendAuthorization`).
  const canSend = usable.includes('gmail.compose')
  const standing = canSend && context.delegatedDm && context.effectiveUserId
    ? await hasStandingSendAuthorization(prisma, {
        agentId: agent.id,
        connectionId,
        interactive: context.interactive,
        organizationId: viewer.organizationId,
        requestingUserId: context.effectiveUserId,
      })
    : false
  steps.push(await policyStep(prisma, actor, {
    agent,
    context,
    readToolId: GMAIL_SEARCH_TOOL_ID,
    send: canSend
      ? standing
        ? { outcome: 'pass', sentence: 'You let it send without asking; each send is still recorded.' }
        : { outcome: 'warn', sentence: 'Sending waits for your approval.' }
      : null,
  }))
  return steps
}
