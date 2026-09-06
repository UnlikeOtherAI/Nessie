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

/**
 * Address-first mailbox discovery contracts. Provider family deliberately says
 * who operates the account; connector type says how Nessie would reach it.
 * Keeping them separate prevents a domain classification from becoming an
 * authority to send a password to a guessed protocol endpoint.
 */
export const MailboxProviderFamilySchema = z.enum([
  'apple',
  'fastmail',
  'google',
  'microsoft',
  'yahoo',
  'zoho',
  'generic',
  'unknown',
])
export type MailboxProviderFamily = z.infer<typeof MailboxProviderFamilySchema>

export const MailboxAuthenticationStrategySchema = z.enum([
  'apple_authorization',
  'app_password',
  'oauth2',
  'password',
  'manual',
])
export type MailboxAuthenticationStrategy = z.infer<typeof MailboxAuthenticationStrategySchema>

export const MailboxConnectorTypeSchema = z.enum([
  'apple_mail',
  'gmail_api',
  'imap_smtp',
  'jmap',
  'microsoft_graph',
  'manual',
])
export type MailboxConnectorType = z.infer<typeof MailboxConnectorTypeSchema>

export const MailboxDiscoveryEvidenceSourceSchema = z.enum([
  'autoconfig',
  'autodiscover_srv',
  'capability_probe',
  'ispdb',
  'jmap_session',
  'jmap_srv',
  'mx_fingerprint',
  'provider_registry',
  'mail_srv',
  'conflict',
])
export type MailboxDiscoveryEvidenceSource = z.infer<typeof MailboxDiscoveryEvidenceSourceSchema>

/** A deliberately sanitised explanation: never a hostname, URL, or probe error. */
export const MailboxDiscoveryEvidenceSchema = z.object({
  source: MailboxDiscoveryEvidenceSourceSchema,
  provider: MailboxProviderFamilySchema.optional(),
  score: z.number().int().min(-100).max(100),
  trustedForCredentials: z.boolean(),
})
export type MailboxDiscoveryEvidence = z.infer<typeof MailboxDiscoveryEvidenceSchema>

const DiscoveredMailboxEndpointSchema = z.object({
  host: hostname,
  port,
  security: MailboxTransportSecuritySchema,
})

export const TrustedMailboxImapSmtpConfigSchema = z.object({
  imap: DiscoveredMailboxEndpointSchema,
  smtp: DiscoveredMailboxEndpointSchema,
  /** Structural only — never a provider-supplied username template. */
  username: z.enum(['email_address', 'local_part']),
})
export type TrustedMailboxImapSmtpConfig = z.infer<typeof TrustedMailboxImapSmtpConfigSchema>

export const MailboxConnectorRecommendationSchema = z.object({
  type: MailboxConnectorTypeSchema,
  /** A recognised protocol is not necessarily installed in this deployment. */
  available: z.boolean(),
  unavailableReason: z.enum(['not_configured', 'not_supported']).nullable(),
})
export type MailboxConnectorRecommendation = z.infer<typeof MailboxConnectorRecommendationSchema>

export const MailboxDiscoveryAuthenticationSchema = z.object({
  strategy: MailboxAuthenticationStrategySchema,
  /** OAuth/Apple availability is explicit rather than inferred from a domain. */
  available: z.boolean(),
  unavailableReason: z.enum(['not_configured', 'not_supported']).nullable(),
})
export type MailboxDiscoveryAuthentication = z.infer<typeof MailboxDiscoveryAuthenticationSchema>

export const DiscoverMailboxConnectionBodySchema = z.object({
  email: z.string().min(3).max(320),
  /** Optional only because personal discovery is the address-first default. */
  scope: MailboxConnectionScopeSchema.optional(),
  teamId: z.string().uuid().optional(),
}).strict()
export type DiscoverMailboxConnectionBody = z.infer<typeof DiscoverMailboxConnectionBodySchema>

export const MailboxDiscoveryExistingConnectionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['comms_connection', 'mailbox_connection']),
  /** Present for a Model A mailbox so the correct existing card can open. */
  scope: MailboxConnectionScopeSchema.optional(),
})
export type MailboxDiscoveryExistingConnection = z.infer<typeof MailboxDiscoveryExistingConnectionSchema>

export const MailboxDiscoveryResultSchema = z.object({
  /** Original local part; domain is ASCII/IDNA canonicalised by discovery. */
  email: z.string().min(3).max(320),
  domain: z.string().min(1).max(253),
  provider: MailboxProviderFamilySchema,
  configurationConfidence: z.number().min(0).max(1),
  credentialDestinationTrust: z.number().min(0).max(1),
  evidence: z.array(MailboxDiscoveryEvidenceSchema).max(16),
  authentication: MailboxDiscoveryAuthenticationSchema,
  preferredConnector: MailboxConnectorRecommendationSchema,
  fallbackConnectors: z.array(MailboxConnectorRecommendationSchema).max(4),
  trustedImapSmtp: TrustedMailboxImapSmtpConfigSchema.optional(),
  /** Only connections the current caller is entitled to see are ever supplied. */
  existingConnection: MailboxDiscoveryExistingConnectionSchema.optional(),
  ui: z.object({
    providerName: z.string().min(1).max(80),
    providerIcon: z.enum(['apple', 'fastmail', 'generic', 'google', 'microsoft', 'yahoo', 'zoho']),
    /** A reviewed protocol fallback exists but must remain an explicit escape hatch. */
    requiresAdvancedSettings: z.boolean(),
    requiresManualSettings: z.boolean(),
    requiresProviderConfirmation: z.boolean(),
  }),
})
export type MailboxDiscoveryResult = z.infer<typeof MailboxDiscoveryResultSchema>
