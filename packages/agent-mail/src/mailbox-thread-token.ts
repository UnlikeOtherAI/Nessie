import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const MAC_BYTES = 16
const PREFIX = 'im3.'

export type MailboxThreadTokenInput = {
  accountId: string
  folder: string
  uidValidity: number | null
  rootMessageId: string | null
  /** A stable root UID, never the newest member of the logical thread. */
  uid: number
}

export type ParsedMailboxThreadToken = {
  accountId: string
  folder: string
  rootDigest: string
  seedUid: number
  uidValidity: number | null
}

const varint = (value: number): number[] => {
  const bytes: number[] = []
  let remaining = value
  do {
    const next = remaining % 128
    remaining = Math.floor(remaining / 128)
    bytes.push(next | (remaining > 0 ? 128 : 0))
  } while (remaining > 0)
  return bytes
}

const readVarint = (bytes: Buffer, offset: number): { offset: number; value: number } | null => {
  let value = 0
  let factor = 1
  for (let index = offset; index < bytes.length && index < offset + 5; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) return null
    value += (byte & 127) * factor
    if ((byte & 128) === 0) return Number.isSafeInteger(value) ? { offset: index + 1, value } : null
    factor *= 128
  }
  return null
}

export const mailboxThreadRootDigest = (
  input: Pick<MailboxThreadTokenInput, 'rootMessageId' | 'uidValidity' | 'uid'>,
): string =>
  createHash('sha256').update(input.rootMessageId
    ?? `unthreaded:${input.uidValidity ?? 'none'}:${input.uid}`).digest('base64url')

const mac = (secret: string, accountId: string, folder: string, payload: Buffer): Buffer =>
  createHmac('sha256', secret).update(accountId).update('\u0000').update(folder).update('\u0000')
    .update(payload).digest().subarray(0, MAC_BYTES)

/**
 * A signed compact token for one logical IMAP thread.
 *
 * Membership and count deliberately do not travel in the public identifier:
 * both change whenever the provider adds a reply.  The reader re-derives the
 * current bounded group and authenticates it against this stable root/seed.
 */
export const mailboxThreadToken = (input: MailboxThreadTokenInput, secret: string): string => {
  if (!secret || !Number.isSafeInteger(input.uid) || input.uid < 1) {
    throw new Error('Invalid mailbox thread token input.')
  }
  const payload = Buffer.from([
    3,
    ...varint(input.uidValidity ?? 0),
    ...varint(input.uid),
    ...Buffer.from(mailboxThreadRootDigest(input), 'base64url'),
  ])
  return `${PREFIX}${Buffer.concat([payload, mac(secret, input.accountId, input.folder, payload)]).toString('base64url')}`
}

export const parseMailboxThreadToken = (
  value: string,
  input: { accountId: string; folder: string; secret: string },
): ParsedMailboxThreadToken | null => {
  if (!value.startsWith(PREFIX) || !input.secret) return null
  try {
    const signed = Buffer.from(value.slice(PREFIX.length), 'base64url')
    if (signed.length < MAC_BYTES + 35) return null
    const payload = signed.subarray(0, -MAC_BYTES)
    const signature = signed.subarray(-MAC_BYTES)
    const expected = mac(input.secret, input.accountId, input.folder, payload)
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected) || payload[0] !== 3) return null
    let offset = 1
    const uidValidity = readVarint(payload, offset); if (!uidValidity) return null; offset = uidValidity.offset
    const seedUid = readVarint(payload, offset); if (!seedUid) return null; offset = seedUid.offset
    const digest = payload.subarray(offset, offset + 32); offset += 32
    if (offset !== payload.length || digest.length !== 32 || seedUid.value < 1) return null
    return {
      accountId: input.accountId,
      folder: input.folder,
      rootDigest: digest.toString('base64url'),
      seedUid: seedUid.value,
      uidValidity: uidValidity.value || null,
    }
  } catch { return null }
}
