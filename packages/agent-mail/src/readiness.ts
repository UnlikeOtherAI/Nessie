/**
 * Hosted agent mail is OFF unless the deployment is configured for it, and a
 * partial configuration is *named* rather than silently degraded. Everything
 * that could refuse — the claim flow, the send path, the inbound route, the
 * settings surface — asks this one resolver, so the reason a person is shown
 * and the reason a tool refuses can never drift apart.
 *
 * Credentials are deliberately not required: with none set the AWS SDK default
 * chain applies, which is how an instance profile / IRSA role is used.
 */

export type AgentMailSettings = {
  sesRegion?: string
  accessKeyId?: string
  secretAccessKey?: string
  domain?: string
  inboundBucket?: string
  inboundPrefix: string
  snsTopicArn: string | undefined
  configurationSet?: string
  inboundRetentionDays: number
  customDomains: boolean
  maxSendsPerHour: number
  maxInboundBytes: number
}

export type AgentMailConfig = {
  sesRegion: string
  accessKeyId?: string
  secretAccessKey?: string
  domain: string
  inboundBucket: string
  inboundPrefix: string
  snsTopicArn: string
  configurationSet?: string
  inboundRetentionDays: number
  customDomains: boolean
  maxSendsPerHour: number
  maxInboundBytes: number
}

export type AgentMailReadiness =
  | { ready: true; config: AgentMailConfig }
  | { ready: false; missing: string[]; reason: string }

/** Env var name per required field, so a refusal can name what to set. */
const REQUIRED_ENV: Record<string, string> = {
  sesRegion: 'NESSIE_EMAIL_SES_REGION',
  domain: 'NESSIE_EMAIL_DOMAIN',
  inboundBucket: 'NESSIE_EMAIL_INBOUND_S3_BUCKET',
  snsTopicArn: 'NESSIE_EMAIL_SNS_TOPIC_ARN',
}

export const AGENT_MAIL_UNCONFIGURED = 'AGENT_MAIL_UNCONFIGURED'

export const resolveAgentMailReadiness = (
  settings: AgentMailSettings | undefined,
): AgentMailReadiness => {
  const values: Record<string, string | undefined> = {
    sesRegion: settings?.sesRegion,
    domain: settings?.domain,
    inboundBucket: settings?.inboundBucket,
    snsTopicArn: settings?.snsTopicArn,
  }
  const missing = Object.keys(REQUIRED_ENV)
    .filter((key) => !values[key]?.trim())
    .map((key) => REQUIRED_ENV[key] as string)

  if (missing.length > 0 || !settings) {
    return {
      missing,
      ready: false,
      reason:
        `Hosted agent email is not configured on this deployment. `
        + `Set ${missing.join(', ')} — see docs/deployment.md "Agent email (Amazon SES)".`,
    }
  }

  return {
    config: {
      accessKeyId: settings.accessKeyId,
      configurationSet: settings.configurationSet,
      customDomains: settings.customDomains,
      domain: normalizeDomain(settings.domain as string),
      inboundBucket: settings.inboundBucket as string,
      inboundPrefix: settings.inboundPrefix,
      inboundRetentionDays: settings.inboundRetentionDays,
      maxInboundBytes: settings.maxInboundBytes,
      maxSendsPerHour: settings.maxSendsPerHour,
      secretAccessKey: settings.secretAccessKey,
      sesRegion: settings.sesRegion as string,
      snsTopicArn: settings.snsTopicArn as string,
    },
    ready: true,
  }
}

export const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '')
