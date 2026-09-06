import { randomUUID, timingSafeEqual } from 'node:crypto'

import type { Prisma } from '@prisma/client'

const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * The primary key of the only `bootstrap_tokens` row an install ever holds.
 * The key is the singleton guarantee; the advisory lock around every write
 * only decides which replica gets to be the one that writes it.
 */
const BOOTSTRAP_TOKEN_ROW_ID = 'singleton'

export type BootstrapTokenState = {
  expiresAt: Date
  token: string
}

/**
 * Thrown by `claimBootstrapToken` when the presented token is not the live
 * one — never issued, already consumed, or expired and replaced. It aborts the
 * transaction that would have created the owner, so a rejected exchange leaves
 * no half-made install behind.
 */
export class BootstrapTokenRejectedError extends Error {
  constructor() {
    super('Bootstrap token is not valid.')
    this.name = 'BootstrapTokenRejectedError'
  }
}

/**
 * Return the install's live owner-bootstrap token, minting one when there is
 * none or the last expired unconsumed.
 *
 * The token was per process before (audit 1.2): every replica logged a
 * different setup URL and an exchange that landed on another replica failed
 * `TOKEN_INVALID`. One row means every replica prints the same URL and any of
 * them can complete the exchange.
 *
 * Call inside a transaction already holding the
 * `nessie:bootstrap-initialization` advisory lock — that is what stops two
 * simultaneous boots from each minting.
 */
export const ensureBootstrapToken = async (
  transaction: Prisma.TransactionClient,
): Promise<BootstrapTokenState> => {
  const live = await transaction.bootstrapToken.findFirst({
    where: { consumedAt: null, expiresAt: { gt: new Date() } },
    select: { expiresAt: true, token: true },
  })
  if (live) return live

  // Expired without being consumed: mint again rather than leave the install
  // unreachable. A single process used to need a restart for this; with the
  // token shared, restarting a replica no longer changes anything.
  const minted: BootstrapTokenState = {
    expiresAt: new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS),
    token: randomUUID(),
  }
  await transaction.bootstrapToken.upsert({
    where: { id: BOOTSTRAP_TOKEN_ROW_ID },
    create: { id: BOOTSTRAP_TOKEN_ROW_ID, ...minted },
    update: { ...minted, consumedAt: null, createdAt: new Date() },
  })
  return minted
}

/**
 * Constant-time string comparison, the standalone twin of the server context's
 * `isTimingSafeMatch`.
 *
 * The bootstrap token is the single credential that provisions the owner
 * account, so it is compared the way the rest of the auth surface compares
 * credentials (2026-09-05 review, FO3-9) rather than by `WHERE token = $1`.
 * Selecting the row by its primary key and comparing here — instead of letting
 * Postgres match on the secret — is what keeps that property once the token
 * lives in a row.
 */
const isTimingSafeMatch = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

/**
 * Burn the presented token or throw `BootstrapTokenRejectedError`.
 *
 * The conditional UPDATE is the claim: it can flip `consumedAt` from NULL
 * exactly once, and it runs in the transaction that creates the owner, so
 * token and owner commit or roll back together. Callers reach this through
 * `seedBootstrapRecords`, which already holds the
 * `nessie:bootstrap-initialization` advisory lock, so the read and the burn
 * cannot interleave with another exchange.
 */
export const claimBootstrapToken = async (
  transaction: Prisma.TransactionClient,
  token: string,
): Promise<void> => {
  const live = await transaction.bootstrapToken.findUnique({
    where: { id: BOOTSTRAP_TOKEN_ROW_ID },
    select: { consumedAt: true, expiresAt: true, token: true },
  })
  // Never issued, already burned, or expired and not yet re-minted: all of
  // them reject identically, so a probe learns nothing about which it was.
  if (!live || live.consumedAt !== null || live.expiresAt.getTime() <= Date.now()) {
    throw new BootstrapTokenRejectedError()
  }
  if (!isTimingSafeMatch(live.token, token)) throw new BootstrapTokenRejectedError()

  const claimed = await transaction.bootstrapToken.updateMany({
    where: { id: BOOTSTRAP_TOKEN_ROW_ID, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (claimed.count !== 1) throw new BootstrapTokenRejectedError()
}
