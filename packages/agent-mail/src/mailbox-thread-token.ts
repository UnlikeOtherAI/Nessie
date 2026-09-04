import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const MAX_MEMBERS = 50
const MAC_BYTES = 16
const PREFIX = 'im2.'

export type MailboxThreadTokenInput = {
  accountId: string
  folder: string
  uidValidity: number | null
  rootMessageId: string | null
  uid: number
  memberUids: number[]
  messageCount: number
}

export type ParsedMailboxThreadToken = {
  accountId: string
  folder: string
  memberUids: number[]
  messageCount: number
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

const rootDigest = (input: Pick<MailboxThreadTokenInput, 'rootMessageId' | 'uidValidity' | 'uid'>): Buffer =>
  createHash('sha256').update(input.rootMessageId
    ?? `unthreaded:${input.uidValidity ?? 'none'}:${input.uid}`).digest()

const mac = (secret: string, accountId: string, folder: string, payload: Buffer): Buffer =>
  createHmac('sha256', secret).update(accountId).update('\u0000').update(folder).update('\u0000')
    .update(payload).digest().subarray(0, MAC_BYTES)

/** A signed compact token; it carries at most the newest 50 listed UIDs. */
export const mailboxThreadToken = (input: MailboxThreadTokenInput, secret: string): string => {
  const members = [...new Set(input.memberUids)].sort((left, right) => right - left).slice(0, MAX_MEMBERS)
  if (!secret || members.length === 0 || !members.includes(input.uid)) throw new Error('Invalid mailbox thread token input.')
  const deltas = members.map((member, index) => index === 0 ? member : members[index - 1]! - member)
  const payload = Buffer.from([
    2,
    ...varint(input.uidValidity ?? 0),
    ...varint(input.uid),
    ...varint(input.messageCount),
    ...rootDigest(input),
    members.length,
    ...deltas.flatMap(varint),
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
    if (signed.length <= MAC_BYTES + 36) return null
    const payload = signed.subarray(0, -MAC_BYTES)
    const signature = signed.subarray(-MAC_BYTES)
    const expected = mac(input.secret, input.accountId, input.folder, payload)
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected) || payload[0] !== 2) return null
    let offset = 1
    const uidValidity = readVarint(payload, offset); if (!uidValidity) return null; offset = uidValidity.offset
    const seedUid = readVarint(payload, offset); if (!seedUid) return null; offset = seedUid.offset
    const messageCount = readVarint(payload, offset); if (!messageCount) return null; offset = messageCount.offset
    const digest = payload.subarray(offset, offset + 32); offset += 32
    const count = payload[offset]; offset += 1
    if (!count || count > MAX_MEMBERS || digest.length !== 32
      || seedUid.value < 1 || messageCount.value < 1) return null
    const memberUids: number[] = []
    for (let index = 0; index < count; index += 1) {
      const delta = readVarint(payload, offset); if (!delta) return null; offset = delta.offset
      const uid = index === 0 ? delta.value : (memberUids[index - 1] ?? 0) - delta.value
      if (uid < 1 || !Number.isSafeInteger(uid)) return null
      memberUids.push(uid)
    }
    if (offset !== payload.length || !memberUids.includes(seedUid.value)) return null
    return {
      accountId: input.accountId,
      folder: input.folder,
      memberUids,
      messageCount: messageCount.value,
      rootDigest: digest.toString('base64url'),
      seedUid: seedUid.value,
      uidValidity: uidValidity.value || null,
    }
  } catch { return null }
}
