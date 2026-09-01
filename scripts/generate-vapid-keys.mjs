#!/usr/bin/env node
/**
 * Generate a VAPID (Web Push, RFC 8292) application-server key pair.
 *
 * Emits the conventional raw Web Push key format — base64url of the 65-byte
 * uncompressed P-256 public point and the 32-byte private scalar — identical to
 * what the `web-push` CLI and browsers use, so the keys interoperate directly.
 *
 * Usage:
 *   node scripts/generate-vapid-keys.mjs
 *
 * Then set these three env vars (the public key is safe to expose; keep the
 * private key secret):
 *   NESSIE_WEBPUSH_PUBLIC_KEY=...
 *   NESSIE_WEBPUSH_PRIVATE_KEY=...
 *   NESSIE_WEBPUSH_SUBJECT=mailto:ops@your-domain.example
 */
import { generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pub = publicKey.export({ format: 'jwk' })
const priv = privateKey.export({ format: 'jwk' })

const publicKeyB64 = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]).toString('base64url')

const privateKeyB64 = Buffer.from(priv.d, 'base64url').toString('base64url')

process.stdout.write(
  [
    '# VAPID key pair for Nessie Web Push — add to your .env / deployment secrets.',
    '# The public key is served to browsers; keep the private key secret.',
    `NESSIE_WEBPUSH_PUBLIC_KEY=${publicKeyB64}`,
    `NESSIE_WEBPUSH_PRIVATE_KEY=${privateKeyB64}`,
    'NESSIE_WEBPUSH_SUBJECT=mailto:ops@example.com',
    '',
  ].join('\n'),
)
