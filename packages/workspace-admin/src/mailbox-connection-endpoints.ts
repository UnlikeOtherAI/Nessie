import type { Prisma, PrismaClient } from '@prisma/client'
import type { MailboxClientOptions, MailboxEndpoints } from '@nessie/agent-mail'
import { openSecret } from '@nessie/comms-connect'

/**
 * The one place a stored mailbox connection becomes a dialable set of endpoints.
 *
 * The password is decrypted here and nowhere else, and the row it comes from is
 * a table no list, presenter or status read ever joins. Everything above this
 * file handles a connection id.
 */

export type MailboxConnectionRow = Prisma.MailboxConnectionGetPayload<object>

export class MailboxCredentialMissingError extends Error {
  readonly kind = 'auth'

  constructor() {
    super('This mailbox has no stored password. Reconnect it to use it again.')
    this.name = 'MailboxCredentialMissingError'
  }
}

const DEFAULT_TIMEOUT_MS = 20_000

export const mailboxDialOptions = (): MailboxClientOptions => {
  const configured = Number(process.env.NESSIE_MAILBOX_TIMEOUT_MS)
  return {
    timeoutMs: Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS,
  }
}

export const mailboxEndpointsFor = async (
  prisma: PrismaClient,
  connection: MailboxConnectionRow,
  encryptionSecret: string,
): Promise<MailboxEndpoints> => {
  const credential = await prisma.mailboxConnectionCredential.findUnique({
    select: { secretCiphertext: true },
    where: { connectionId: connection.id },
  })
  if (!credential) throw new MailboxCredentialMissingError()
  return {
    address: connection.address,
    imap: {
      host: connection.imapHost,
      port: connection.imapPort,
      security: connection.imapSecurity,
    },
    password: openSecret(encryptionSecret, credential.secretCiphertext),
    smtp: {
      host: connection.smtpHost,
      port: connection.smtpPort,
      security: connection.smtpSecurity,
    },
    username: connection.username,
  }
}
