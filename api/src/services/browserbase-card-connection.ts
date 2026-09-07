import type { Prisma, PrismaClient } from '@prisma/client'
import {
  isCloudBrowserError,
  persistCloudBrowserConnection,
  probeCloudBrowserConnection,
  type CloudBrowserConnectionProbeDeps,
} from '@nessie/browser-cloud'
import type { AgentCardSecretDestination } from '@nessie/schemas'

type BrowserbaseDestination = Extract<
  AgentCardSecretDestination,
  { kind: 'browserbase_connection' }
>

export type BrowserbaseCardSecretDeps = CloudBrowserConnectionProbeDeps & {
  /** Creates an encrypted store bound to the winning card response transaction. */
  storeSecret: (tx: Prisma.TransactionClient, apiKey: string) => Promise<string>
}

export type PreparedBrowserbaseCardConnection = {
  /** Held only from a successful probe to the card's winning transaction. */
  apiKey: string
  actingUserId: string
  key: string
  organizationId: string
  scope: 'organization' | 'team' | 'user'
  teamId: string | null
  userId: string | null
}

export class BrowserbaseCardConnectionError extends Error {
  constructor(
    readonly httpStatus: 403 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BrowserbaseCardConnectionError'
  }
}

/**
 * Validate the presser's scope and prove the key works. This deliberately
 * does not create or replace a connection: a card may still lose its CAS or
 * another secret field may refuse, in which case the card remains retryable.
 */
export const prepareBrowserbaseCardConnection = async (
  prisma: PrismaClient,
  input: {
    browserCloud: BrowserbaseCardSecretDeps
    destination: BrowserbaseDestination
    isOwner: boolean
    key: string
    organizationId: string
    userId: string
    value: string
  },
): Promise<PreparedBrowserbaseCardConnection> => {
  const { destination } = input
  if (destination.scope !== 'user' && !input.isOwner) {
    throw new BrowserbaseCardConnectionError(
      403,
      'CARD_SECRET_REFUSED',
      'Only an organisation owner can connect a shared Browserbase account.',
    )
  }
  if (destination.scope === 'team') {
    const team = await prisma.team.findFirst({
      select: { id: true },
      where: {
        id: destination.teamId,
        project: { organizationId: input.organizationId },
      },
    })
    if (!team) {
      throw new BrowserbaseCardConnectionError(
        409,
        'CARD_SECRET_REFUSED',
        'That team is no longer available for a Browserbase account.',
      )
    }
  }
  try {
    await probeCloudBrowserConnection(input.browserCloud, { apiKey: input.value })
  } catch (error) {
    if (isCloudBrowserError(error)) {
      throw new BrowserbaseCardConnectionError(502, error.code, error.message)
    }
    throw error
  }
  return {
    actingUserId: input.userId,
    apiKey: input.value,
    key: input.key,
    organizationId: input.organizationId,
    scope: destination.scope,
    teamId: destination.scope === 'team' ? destination.teamId ?? null : null,
    userId: destination.scope === 'user' ? input.userId : null,
  }
}

/** Persist only after the card response has won its conditional claim. */
export const persistPreparedBrowserbaseCardConnection = async (
  tx: Prisma.TransactionClient,
  deps: Pick<BrowserbaseCardSecretDeps, 'storeSecret'>,
  connection: PreparedBrowserbaseCardConnection,
): Promise<void> => {
  await persistCloudBrowserConnection(
    {
      prisma: tx,
      storeSecret: (apiKey) => deps.storeSecret(tx, apiKey),
    },
    connection,
  )
}
