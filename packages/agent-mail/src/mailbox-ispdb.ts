import type { MailboxTransportSecurity, TrustedMailboxImapSmtpConfig } from '@nessie/schemas'

/**
 * A reviewed snapshot of long-tail provider settings, in the shape Mozilla's
 * public autoconfiguration database publishes them.
 *
 * It is a **snapshot**, deliberately: a third-party configuration endpoint
 * queried at connect time would decide where somebody's mail password is sent,
 * which is the one decision this system never delegates. Every entry here was
 * read from the provider's own published settings page, and carries that
 * reference so the next person can re-verify it rather than trust this file.
 *
 * An entry is a *configuration* source, not a provider adapter: these providers
 * get no OAuth route, no native API and no `MailboxProviderFamily` of their own.
 * They resolve to the generic password path with their real name shown, which
 * is why adding one is a data change and never a schema change.
 */

export const MAILBOX_ISPDB_VERSION = 1

export type MailboxIspdbEntry = {
  /** Mail domains this entry configures, lowercase and already IDNA-canonical. */
  readonly domains: readonly string[]
  /** Shown to the person as "Sign in to …"; the provider's own product name. */
  readonly displayName: string
  readonly config: TrustedMailboxImapSmtpConfig
  /** The provider's published settings page this entry was verified against. */
  readonly reference: string
  /** ISO date that reference was last read. Re-verify before trusting an old one. */
  readonly verifiedOn: string
}

/** The date every entry below was last read from its `reference`. */
const VERIFIED_ON = '2026-09-04'

/** `[host, port, security]`, in the order the reference states them. */
type Endpoint = readonly [host: string, port: number, security: MailboxTransportSecurity]

const defineEntry = (input: {
  displayName: string
  domains: readonly string[]
  imap: Endpoint
  smtp: Endpoint
  reference: string
  /** Only where the reference documents `%EMAILLOCALPART%` rather than the address. */
  username?: TrustedMailboxImapSmtpConfig['username']
}): MailboxIspdbEntry => ({
  displayName: input.displayName,
  domains: input.domains,
  config: {
    imap: { host: input.imap[0], port: input.imap[1], security: input.imap[2] },
    smtp: { host: input.smtp[0], port: input.smtp[1], security: input.smtp[2] },
    username: input.username ?? 'email_address',
  },
  reference: input.reference,
  verifiedOn: VERIFIED_ON,
})

export const MAILBOX_ISPDB: readonly MailboxIspdbEntry[] = [
  defineEntry({
    displayName: 'GMX',
    domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.eu', 'gmx.biz', 'gmx.org', 'gmx.info'],
    imap: ['imap.gmx.net', 993, 'tls'],
    smtp: ['mail.gmx.net', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/gmx.net',
  }),
  defineEntry({
    displayName: 'GMX International',
    domains: ['gmx.com', 'gmx.us', 'gmx.co.uk', 'gmx.fr', 'gmx.es', 'gmx.it', 'gmx.ca', 'gmx.ie'],
    imap: ['imap.gmx.com', 993, 'tls'],
    smtp: ['mail.gmx.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/gmx.com',
  }),
  defineEntry({
    displayName: 'WEB.DE',
    domains: ['web.de'],
    imap: ['imap.web.de', 993, 'tls'],
    smtp: ['smtp.web.de', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/web.de',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'Telekom Mail',
    domains: ['t-online.de', 'magenta.de'],
    imap: ['secureimap.t-online.de', 993, 'tls'],
    smtp: ['securesmtp.t-online.de', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/t-online.de',
  }),
  defineEntry({
    displayName: 'mail.com',
    domains: [
      'mail.com', 'email.com', 'usa.com', 'post.com', 'myself.com', 'consultant.com',
      'dr.com', 'engineer.com', 'writeme.com', 'techie.com', 'europe.com', 'london.com',
    ],
    imap: ['imap.mail.com', 993, 'tls'],
    smtp: ['smtp.mail.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/mail.com',
  }),
  defineEntry({
    displayName: 'Posteo',
    domains: [
      'posteo.de', 'posteo.net', 'posteo.eu', 'posteo.org', 'posteo.com',
      'posteo.at', 'posteo.ch', 'posteo.uk',
    ],
    imap: ['posteo.de', 993, 'tls'],
    smtp: ['posteo.de', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/posteo.de',
  }),
  defineEntry({
    displayName: 'mailbox.org',
    domains: ['mailbox.org'],
    imap: ['imap.mailbox.org', 993, 'tls'],
    smtp: ['smtp.mailbox.org', 465, 'tls'],
    reference: 'https://autoconfig.mailbox.org/mail/config-v1.1.xml',
  }),
  defineEntry({
    displayName: 'Mail.ru',
    domains: ['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru'],
    imap: ['imap.mail.ru', 993, 'tls'],
    smtp: ['smtp.mail.ru', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/mail.ru',
  }),
  defineEntry({
    displayName: 'Yandex Mail',
    domains: ['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'ya.ru', 'narod.ru'],
    imap: ['imap.yandex.com', 993, 'tls'],
    smtp: ['smtp.yandex.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/yandex.ru',
  }),
  defineEntry({
    displayName: 'Seznam',
    domains: ['seznam.cz', 'email.cz', 'post.cz', 'spoluzaci.cz'],
    imap: ['imap.seznam.cz', 993, 'tls'],
    smtp: ['smtp.seznam.cz', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/seznam.cz',
  }),
  defineEntry({
    displayName: 'Poczta Wirtualna Polska',
    domains: ['wp.pl'],
    imap: ['imap.wp.pl', 993, 'tls'],
    smtp: ['smtp.wp.pl', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/wp.pl',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'Onet Poczta',
    domains: ['onet.pl', 'onet.eu', 'poczta.onet.pl', 'op.pl', 'vp.pl', 'republika.pl'],
    imap: ['imap.poczta.onet.pl', 993, 'tls'],
    smtp: ['smtp.poczta.onet.pl', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/onet.pl',
  }),
  defineEntry({
    displayName: 'Libero Mail',
    domains: ['libero.it', 'iol.it', 'inwind.it', 'blu.it', 'giallo.it'],
    imap: ['imapmail.libero.it', 993, 'tls'],
    smtp: ['smtp.libero.it', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/libero.it',
  }),
  defineEntry({
    displayName: 'Mail Orange',
    domains: ['orange.fr', 'wanadoo.fr'],
    imap: ['imap.orange.fr', 993, 'tls'],
    smtp: ['smtp.orange.fr', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/orange.fr',
  }),
  defineEntry({
    displayName: 'Free',
    domains: ['free.fr'],
    imap: ['imap.free.fr', 993, 'tls'],
    smtp: ['smtp.free.fr', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/free.fr',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'SFR',
    domains: ['sfr.fr', 'neuf.fr', 'club-internet.fr'],
    imap: ['imap.sfr.fr', 993, 'tls'],
    smtp: ['smtp.sfr.fr', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/sfr.fr',
  }),
  defineEntry({
    displayName: 'LaPoste',
    domains: ['laposte.net'],
    imap: ['imap.laposte.net', 993, 'tls'],
    smtp: ['smtp.laposte.net', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/laposte.net',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'SAPO Mail',
    domains: ['sapo.pt', 'sapo.cv', 'sapo.ao', 'sapo.mz', 'meo.pt'],
    imap: ['imap.sapo.pt', 993, 'tls'],
    smtp: ['smtp.sapo.pt', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/sapo.pt',
  }),
  defineEntry({
    // The reference documents no implicit-TLS submission port for UOL.
    displayName: 'UOL',
    domains: ['uol.com.br'],
    imap: ['imap.uol.com.br', 993, 'tls'],
    smtp: ['smtps.uol.com.br', 587, 'starttls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/uol.com.br',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'AOL Mail',
    domains: ['aol.com', 'aim.com', 'netscape.net', 'compuserve.com', 'aol.co.uk', 'aol.de', 'aol.fr'],
    imap: ['imap.aol.com', 993, 'tls'],
    smtp: ['smtp.aol.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/aol.com',
  }),
  defineEntry({
    // Xfinity's own client-setup page documents submission on 587 with STARTTLS.
    displayName: 'Xfinity',
    domains: ['comcast.net'],
    imap: ['imap.comcast.net', 993, 'tls'],
    smtp: ['smtp.comcast.net', 587, 'starttls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/comcast.net',
  }),
  defineEntry({
    displayName: 'AT&T Mail',
    domains: [
      'att.net', 'sbcglobal.net', 'bellsouth.net', 'pacbell.net', 'ameritech.net',
      'prodigy.net', 'swbell.net', 'snet.net', 'flash.net', 'currently.com',
    ],
    imap: ['imap.mail.att.net', 993, 'tls'],
    smtp: ['smtp.mail.att.net', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/att.net',
  }),
  defineEntry({
    displayName: 'BT Mail',
    domains: ['btinternet.com', 'btopenworld.com', 'talk21.com'],
    imap: ['mail.btinternet.com', 993, 'tls'],
    smtp: ['mail.btinternet.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/btinternet.com',
  }),
  defineEntry({
    displayName: 'Virgin Media Mail',
    domains: ['virginmedia.com'],
    imap: ['imap.virginmedia.com', 993, 'tls'],
    smtp: ['smtp.virginmedia.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/virginmedia.com',
  }),
  defineEntry({
    displayName: 'Telstra Mail',
    domains: ['bigpond.com', 'bigpond.net.au', 'telstra.com'],
    imap: ['imap.telstra.com', 993, 'tls'],
    smtp: ['smtp.telstra.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/bigpond.com',
  }),
  defineEntry({
    displayName: 'QQ Mail',
    domains: ['qq.com'],
    imap: ['imap.qq.com', 993, 'tls'],
    smtp: ['smtp.qq.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/qq.com',
  }),
  defineEntry({
    displayName: 'NetEase Mail',
    domains: ['163.com'],
    imap: ['imap.163.com', 993, 'tls'],
    smtp: ['smtp.163.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/163.com',
  }),
  defineEntry({
    displayName: 'Naver Mail',
    domains: ['naver.com'],
    imap: ['imap.naver.com', 993, 'tls'],
    smtp: ['smtp.naver.com', 465, 'tls'],
    reference: 'https://autoconfig.thunderbird.net/v1.1/naver.com',
  }),
  defineEntry({
    displayName: 'Runbox',
    domains: ['runbox.com', 'runbox.no'],
    imap: ['mail.runbox.com', 993, 'tls'],
    smtp: ['mail.runbox.com', 465, 'tls'],
    reference: 'https://autoconfig.runbox.com/mail/config-v1.1.xml',
    username: 'local_part',
  }),
  defineEntry({
    displayName: 'Mailfence',
    domains: ['mailfence.com'],
    imap: ['imap.mailfence.com', 993, 'tls'],
    smtp: ['smtp.mailfence.com', 465, 'tls'],
    reference: 'https://mailfence.com/.well-known/autoconfig/mail/config-v1.1.xml',
  }),
]

export const ispdbForDomain = (
  domain: string,
  ispdb: readonly MailboxIspdbEntry[] = MAILBOX_ISPDB,
): MailboxIspdbEntry | undefined =>
  ispdb.find((entry) => entry.domains.includes(domain))
