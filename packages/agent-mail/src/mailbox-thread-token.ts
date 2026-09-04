import { createHash } from 'node:crypto'

const HEADER_WINDOW_LIMIT = 100

export type MailboxThreadTokenInput = {
  accountId: string
  folder: string
  uidValidity: number | null
  rootMessageId: string | null
  uid: number
  memberUids?: number[]
  messageCount?: number
}

export const mailboxThreadToken = (input: MailboxThreadTokenInput): string => {
  const listed = input.memberUids !== undefined
  return Buffer.from(JSON.stringify({
    a: input.accountId, c: input.messageCount ?? 1, f: input.folder,
    m: listed ? [...(input.memberUids ?? [])].sort((left, right) => right - left) : [],
    r: createHash('sha256').update(input.rootMessageId ?? '').digest('base64url'),
    s: listed ? input.uid : input.rootMessageId ? 0 : input.uid,
    u: listed ? input.uidValidity : input.rootMessageId ? null : input.uidValidity,
    v: 1,
  })).toString('base64url')
}

export type ParsedMailboxThreadToken = {
  accountId: string; folder: string; memberUids: number[]; messageCount: number
  rootDigest: string; seedUid: number; uidValidity: number | null
}

export const parseMailboxThreadToken = (value: string): ParsedMailboxThreadToken | null => {
  try {
    const token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    const members = Array.isArray(token.m) ? token.m : []
    if (token.v !== 1 || typeof token.a !== 'string' || typeof token.f !== 'string'
      || typeof token.r !== 'string' || !Number.isInteger(token.s) || !Number.isInteger(token.c)
      || Number(token.s) <= 0 || Number(token.c) < 1 || members.length === 0
      || !members.every((member) => Number.isInteger(member) && Number(member) > 0)) return null
    return {
      accountId: token.a, folder: token.f, memberUids: members.map(Number).slice(0, HEADER_WINDOW_LIMIT),
      messageCount: Number(token.c), rootDigest: token.r, seedUid: Number(token.s),
      uidValidity: Number.isInteger(token.u) ? Number(token.u) : null,
    }
  } catch { return null }
}
