export {
  AGENT_MAIL_UNCONFIGURED,
  normalizeDomain,
  resolveAgentMailReadiness,
  type AgentMailConfig,
  type AgentMailReadiness,
  type AgentMailSettings,
} from './readiness.js'

export {
  MAX_LOCAL_PART_LENGTH,
  MIN_LOCAL_PART_LENGTH,
  RESERVED_LOCAL_PARTS,
  addressDomain,
  buildAddress,
  localPartRejectionMessage,
  normalizeAddress,
  normalizeMessageId,
  parseReferences,
  suggestLocalParts,
  validateLocalPart,
  type LocalPartRejection,
} from './address.js'

export {
  classifyInboundEmail,
  shouldWakeAgent,
  verdictsBlockAutonomy,
  type ClassificationInput,
  type EmailClassification,
  type ReceiptVerdicts,
} from './classification.js'

export {
  buildSnippet,
  htmlToText,
  sanitizeEmailHtml,
  type SanitizeResult,
} from './sanitize-html.js'

export {
  isAllowedSigningCertUrl,
  parseSnsEnvelope,
  verifySnsMessage,
  type CertificateFetch,
  type SnsEnvelope,
  type SnsMessageType,
  type SnsVerificationFailure,
  type SnsVerificationResult,
} from './sns.js'

export {
  bounceIsPermanent,
  parseSesNotification,
  type SesDeliveryEvent,
  type SesInboundReceipt,
  type SesNotification,
} from './ses-events.js'

export {
  buildOutboundMime,
  parseInboundEmail,
  replySubject,
  type OutboundAttachment,
  type OutboundEmail,
  type ParsedAttachment,
  type ParsedEmail,
} from './mime.js'

export {
  InboundObjectTooLargeError,
  createAgentMailTransport,
  type AgentMailTransport,
} from './transport.js'

export {
  resolveInboundThreading,
  type ThreadingCandidate,
  type ThreadingDecision,
} from './threading.js'

export {
  MailDialError,
  dialPlain,
  dialTls,
  upgradeToTls,
  type DialOptions,
  type MailDialErrorKind,
  type MailEndpoint,
  type MailSecurity,
} from './dial.js'

export { MailWire, MailWireError, type MailWireOptions } from './wire.js'

export { ImapError, ImapSession, parseThreadReferenceSets, type ImapPart } from './imap.js'

export {
  SmtpError,
  closeSmtpSession,
  openSmtpSession,
  runSmtpHandshake,
  sendOverSmtp,
  type SmtpSession,
} from './smtp.js'

export {
  readMailboxMessage,
  readMailboxMailConversation,
  listMailboxMailThreads,
  mailboxThreadToken,
  searchMailbox,
  sendFromMailbox,
  testMailboxConnection,
  type MailboxClientOptions,
  type MailboxEndpoints,
  type MailboxMessage,
  type MailboxMailConversation,
  type MailboxMailThreadPage,
  type MailboxSearchQuery,
  type MailboxSummary,
} from './mailbox-client.js'

export {
  createMailboxDiscoveryService,
  MailboxDiscoveryAddressError,
  parseMailboxDiscoveryAddress,
  type MailboxDiscoveryCapabilities,
  type MailboxDiscoveryDeps,
  type MailboxDiscoveryDns,
  type MailboxDiscoveryFetch,
  type MailboxDiscoveryTimeout,
} from './mailbox-discovery.js'

export {
  MAILBOX_PROVIDER_REGISTRY,
  MAILBOX_PROVIDER_REGISTRY_VERSION,
  providerForAutodiscover,
  providerForDomain,
  providerForMx,
  type MailboxProviderRegistryEntry,
} from './provider-registry.js'
