import type { TrustedMailboxImapSmtpConfig } from '@nessie/schemas'

import { mailboxDiscoveryHostname } from './mailbox-discovery-address.js'

const textIn = (source: string, tag: string): string | null => {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(source)
  return match?.[1]?.trim() ?? null
}

type XmlEndpoint = {
  host: string
  port: number
  security: 'tls' | 'starttls'
  username: 'email_address' | 'local_part'
}

const endpointFromXml = (body: string, kind: 'imap' | 'smtp'): XmlEndpoint | null => {
  const tag = kind === 'imap' ? 'incomingServer' : 'outgoingServer'
  const server = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(body)
  if (!server || !new RegExp(`\\btype\\s*=\\s*["']${kind}["']`, 'i').test(server[1] ?? '')) return null
  const content = server[2] ?? ''
  const host = mailboxDiscoveryHostname(textIn(content, 'hostname') ?? '')
  const port = Number(textIn(content, 'port'))
  const socketType = (textIn(content, 'socketType') ?? '').trim().toLowerCase()
  const template = textIn(content, 'username')
  const username = template === null || template === '%EMAILADDRESS%'
    ? 'email_address' : template === '%EMAILLOCALPART%' ? 'local_part' : null
  const security = socketType === 'ssl' || socketType === 'tls'
    ? 'tls' : socketType === 'starttls' ? 'starttls' : null
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535 || !security || !username) return null
  return { host, port, security, username }
}

/** Parse the narrow reviewed Thunderbird format; declarations are refused. */
export const parseMailboxAutoconfig = (body: string): TrustedMailboxImapSmtpConfig | null => {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) return null
  const imap = endpointFromXml(body, 'imap')
  const smtp = endpointFromXml(body, 'smtp')
  if (!imap || !smtp || imap.username !== smtp.username) return null
  return {
    imap: { host: imap.host, port: imap.port, security: imap.security },
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
    username: imap.username,
  }
}
