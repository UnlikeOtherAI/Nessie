import { z } from 'zod'

/**
 * API contracts for SMTP/IMAP mailbox connections — agent email Model A.
 * See docs/plans/2026-09-02-agent-email.md §2.2.
 */

export const MailboxTransportSecuritySchema = z.enum(['tls', 'starttls'])
export type MailboxTransportSecurity = z.infer<typeof MailboxTransportSecuritySchema>

export const MailboxConnectionScopeSchema = z.enum(['user', 'team'])
export type MailboxConnectionScope = z.infer<typeof MailboxConnectionScopeSchema>

export const MailboxConnectionStatusSchema = z.enum([
  'active',
  'needs_reauthorization',
  'disabled',
])
export type MailboxConnectionStatus = z.infer<typeof MailboxConnectionStatusSchema>

/**
 * What a browser is allowed to see. Deliberately carries no credential field of
 * any kind — the password lives in a separate table that no read behind this
 * shape joins, so there is nothing here to forget to strip.
 */
export const MailboxConnectionRecordSchema = z.object({
  id: z.string().uuid(),
  scope: MailboxConnectionScopeSchema,
  ownerUserId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  label: z.string(),
  address: z.string(),
  imapHost: z.string(),
  imapPort: z.number().int(),
  imapSecurity: MailboxTransportSecuritySchema,
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecurity: MailboxTransportSecuritySchema,
  username: z.string(),
  status: MailboxConnectionStatusSchema,
  statusReason: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  /** Agents holding an access row for this mailbox. */
  agentIds: z.array(z.string().uuid()),
})
export type MailboxConnectionRecord = z.infer<typeof MailboxConnectionRecordSchema>

const hostname = z.string().min(1).max(253)
const port = z.number().int().min(1).max(65_535)

export const CreateMailboxConnectionBodySchema = z.object({
  scope: MailboxConnectionScopeSchema,
  teamId: z.string().uuid().nullish(),
  label: z.string().min(1).max(120),
  address: z.string().min(3).max(320),
  username: z.string().min(1).max(320),
  /** Submitted once and sealed; never returned by any read. */
  password: z.string().min(1).max(1024),
  imapHost: hostname,
  imapPort: port,
  imapSecurity: MailboxTransportSecuritySchema,
  smtpHost: hostname,
  smtpPort: port,
  smtpSecurity: MailboxTransportSecuritySchema,
})
export type CreateMailboxConnectionBody = z.infer<typeof CreateMailboxConnectionBodySchema>

export const SetMailboxAgentAccessBodySchema = z.object({
  agentId: z.string().uuid(),
  allowed: z.boolean(),
})
export type SetMailboxAgentAccessBody = z.infer<typeof SetMailboxAgentAccessBodySchema>
