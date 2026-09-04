import { connect as netConnect, isIP, type Socket } from 'node:net'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { resolveVettedAddresses, UrlSafetyError } from '@nessie/runtime'

/**
 * Opening a socket to an operator-supplied mail server.
 *
 * `safeFetch` is HTTP-only, so IMAP and SMTP get the same discipline expressed
 * for raw sockets: **pin the validation, not the addresses**. The host is
 * re-resolved and re-vetted against the shared private-range rules on every
 * dial — never cached on the connection row, because mail providers rotate
 * addresses and a stale pin becomes a reliability bug — and the socket is then
 * opened to a literal address that was just vetted, so nothing can be
 * re-resolved into the private network between the check and the connect.
 *
 * Dialling by IP is what makes that airtight, and it is also the gotcha: TLS
 * would then verify the certificate against an IP nobody issued one for. Both
 * paths therefore set `servername` to the *configured hostname* for SNI and
 * check the certificate against that same name explicitly.
 *
 * TLS is not optional. `tls` is implicit TLS; `starttls` opens plaintext and
 * upgrades before anything secret is written, and the protocol clients refuse
 * to continue if the upgrade does not happen — a server that omits STARTTLS
 * from its capabilities is a downgrade, not a fallback.
 */

export type MailSecurity = 'tls' | 'starttls'

export type MailEndpoint = {
  host: string
  port: number
  security: MailSecurity
}

export type MailDialErrorKind = 'certificate' | 'invalid_endpoint' | 'network'

export class MailDialError extends Error {
  constructor(
    message: string,
    readonly kind: MailDialErrorKind = 'network',
  ) {
    super(message)
    this.name = 'MailDialError'
  }
}

const TLS_MIN_VERSION = 'TLSv1.2' as const

export type DialOptions = {
  timeoutMs: number
  /** Test seam only; production always resolves through the shared vetting. */
  resolveHost?: (hostname: string) => Promise<string[]>
}

const assertPort = (port: number): void => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MailDialError('That port number is not valid.', 'invalid_endpoint')
  }
}

const CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const socketFailure = (error: Error): MailDialError => {
  const code = (error as NodeJS.ErrnoException).code
  return new MailDialError(
    CERTIFICATE_ERROR_CODES.has(code ?? '')
      ? 'The mail server certificate could not be verified.'
      : 'The mail server could not be reached.',
    CERTIFICATE_ERROR_CODES.has(code ?? '') ? 'certificate' : 'network',
  )
}

/** The one place a mail host is turned into an address we are willing to dial. */
const vettedAddress = async (host: string, options: DialOptions): Promise<string> => {
  let addresses: string[]
  try {
    addresses = await resolveVettedAddresses(
      host,
      options.resolveHost ? { resolveHost: options.resolveHost } : undefined,
    )
  } catch (error) {
    // The shared guard speaks in URLs, because that is what every other caller
    // hands it. Somebody typing a mail server into a form has not typed a URL,
    // so the refusal is restated in their terms — the rule is unchanged.
    throw new MailDialError(
      error instanceof UrlSafetyError
        ? `${host} is on a private or local network, which a mail server cannot be.`
        : `${host} could not be looked up as a mail server.`,
      'network',
    )
  }
  const address = addresses[0]
  if (!address) throw new MailDialError('That mail server hostname does not resolve.')
  return address
}

const withConnectTimeout = <T extends Socket>(
  socket: T,
  timeoutMs: number,
  event: 'connect' | 'secureConnect',
): Promise<T> =>
  new Promise((resolve, reject) => {
    const settle = (error?: Error): void => {
      socket.setTimeout(0)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      if (error) {
        socket.destroy()
        reject(error)
        return
      }
      resolve(socket)
    }
    const onError = (error: Error): void => settle(socketFailure(error))
    const onTimeout = (): void =>
      settle(new MailDialError('The mail server did not answer in time.', 'network'))
    socket.setTimeout(timeoutMs)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    socket.once(event, () => settle())
  })

/** Implicit TLS: encrypted from the first byte. */
export const dialTls = async (
  endpoint: { host: string; port: number },
  options: DialOptions,
): Promise<TLSSocket> => {
  assertPort(endpoint.port)
  const address = await vettedAddress(endpoint.host, options)
  const socket = tlsConnect({
    checkServerIdentity: (_host, certificate) =>
      checkServerIdentity(endpoint.host, certificate),
    // No `family`: `address` is a literal, so Node infers it, and the TLS
    // option type does not carry the field.
    host: address,
    minVersion: TLS_MIN_VERSION,
    port: endpoint.port,
    rejectUnauthorized: true,
    servername: endpoint.host,
  })
  return withConnectTimeout(socket, options.timeoutMs, 'secureConnect')
}

/** Plaintext, for a STARTTLS endpoint. Nothing secret may be written to it. */
export const dialPlain = async (
  endpoint: { host: string; port: number },
  options: DialOptions,
): Promise<Socket> => {
  assertPort(endpoint.port)
  const address = await vettedAddress(endpoint.host, options)
  const socket = netConnect({ family: isIP(address), host: address, port: endpoint.port })
  return withConnectTimeout(socket, options.timeoutMs, 'connect')
}

/**
 * Upgrade a plaintext socket in place. The certificate is checked against the
 * configured hostname, not against whatever the server volunteers.
 */
export const upgradeToTls = async (
  socket: Socket,
  host: string,
  options: DialOptions,
): Promise<TLSSocket> => {
  const secured = tlsConnect({
    checkServerIdentity: (_host, certificate) => checkServerIdentity(host, certificate),
    minVersion: TLS_MIN_VERSION,
    rejectUnauthorized: true,
    servername: host,
    socket,
  })
  return withConnectTimeout(secured, options.timeoutMs, 'secureConnect')
}
