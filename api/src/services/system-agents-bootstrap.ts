/**
 * Nessie's own agents — the Personal Assistant and every global-agent
 * blueprint — ensured for one person in one organisation.
 *
 * Both tiers are one row per organisation, so every team of that organisation
 * has them the moment they exist; what is per person is the home DM each one
 * is reached through. The two ensures always ran together, copied at four
 * login and provisioning sites, and nowhere else — so a person's FIRST entry
 * into an organisation that is not a login (a team switch, a brand-new team or
 * organisation they just created, an accepted invitation, an adopted refresh
 * drift) landed them in an organisation with no Personal Assistant and no
 * Agent Designer until their next interactive sign-in. One function now, so a
 * new entry path cannot bring one tier without the other.
 */
import type { PrismaClient } from '@prisma/client'

import { attemptGlobalAgentsBootstrap } from './global-agents.js'
import { ensurePersonalAssistantBootstrap } from './personal-assistant.js'

/**
 * An organisation and a person, nothing else: the hidden system teams these
 * agents' DMs hang from live under the organisation's channel root
 * (`ensureSystemTeam`), so no team of the person's is involved.
 */
export type SystemAgentsBootstrapInput = {
  organizationId: string
  userId: string
}

/**
 * Login and provisioning policy: the Personal Assistant is the product's
 * spine, so its failure propagates and the login fails rather than issuing a
 * session with no assistant; the global tier is best-effort and reported,
 * because a blueprint problem must never lock somebody out of their team.
 */
export const ensureSystemAgentsForMember = async (
  prisma: PrismaClient,
  input: SystemAgentsBootstrapInput,
  onGlobalAgentError: (error: unknown) => void,
): Promise<void> => {
  await ensurePersonalAssistantBootstrap(prisma, input)
  await attemptGlobalAgentsBootstrap(prisma, input, onGlobalAgentError)
}

/**
 * The same bootstrap where nothing may fail: a session that is rescoping into
 * an organisation has already consumed its upstream credential, so the switch
 * must land. Every failure is reported and the next interactive login retries
 * — both ensures are idempotent by construction.
 */
export const attemptSystemAgentsBootstrap = async (
  prisma: PrismaClient,
  input: SystemAgentsBootstrapInput,
  onError: (error: unknown) => void,
): Promise<void> => {
  try {
    await ensureSystemAgentsForMember(prisma, input, onError)
  } catch (error) {
    onError(error)
  }
}
