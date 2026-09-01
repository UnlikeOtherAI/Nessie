#!/usr/bin/env node

import { createPrivateKey } from 'node:crypto'

const appKey = process.env.UOA_BILLING_APP_KEY_NESSIE?.trim() ?? ''
const actorPrivateJwk =
  process.env.UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE?.trim() ?? ''

const reject = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!/^uoa_app_[A-Za-z0-9_-]{16,}$/.test(appKey)) {
  reject('Refusing to deploy an invalid Nessie UOA billing app key')
}

try {
  const key = JSON.parse(actorPrivateJwk)
  const valid =
    key.kty === 'RSA'
    && typeof key.kid === 'string'
    && key.kid.length > 0
    && typeof key.n === 'string'
    && key.n.length > 0
    && typeof key.e === 'string'
    && key.e.length > 0
    && typeof key.d === 'string'
    && key.d.length > 0
    && (key.alg === undefined || key.alg === 'RS256')
    && (key.use === undefined || key.use === 'sig')

  if (!valid) {
    throw new Error('invalid key metadata')
  }
  createPrivateKey({ format: 'jwk', key })
} catch {
  reject('Refusing to deploy an invalid Nessie UOA billing actor key')
}
