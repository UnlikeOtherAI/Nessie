import { createPublicKey, verify } from 'node:crypto'

const fixtureOrigin = process.env.SMOKE_UOA_BASE_URL
const expectedDomain = process.env.SMOKE_UOA_DOMAIN
const expectedOrganizationId = process.env.SMOKE_UOA_ORGANIZATION_ID
const expectedSubject = process.env.SMOKE_UOA_SUBJECT
const expectedTeamId = process.env.SMOKE_UOA_TEAM_ID
const expectedTokenVersion = Number(process.env.SMOKE_UOA_TOKEN_VERSION)
const publicKey = createPublicKey(Buffer.from(
  process.env.SMOKE_UOA_PUBLIC_KEY_B64 ?? '',
  'base64',
).toString('utf8'))
const originalFetch = globalThis.fetch

const assertion = (value) => {
  const [header, payload, signature] = value?.split('.') ?? []
  if (!header || !payload || !signature) return null
  try {
    return {
      header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      signature: Buffer.from(signature, 'base64url'),
      signingInput: `${header}.${payload}`,
    }
  } catch {
    return null
  }
}

const requestUrl = (input) =>
  input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)

const orgMeResponse = (status, body) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
})

const validAssertion = (value) => {
  const now = Math.floor(Date.now() / 1000)
  const active = value && typeof value.payload.active === 'object' && value.payload.active
  return Boolean(
    value
    && value.header.alg === 'RS256'
    && value.payload.aud === `${fixtureOrigin}/org`
    && value.payload.exp > now
    && value.payload.iat <= now
    && value.payload.iss === expectedDomain
    && value.payload.sub === expectedSubject
    && value.payload.tv === expectedTokenVersion
    && active.orgId === expectedOrganizationId
    && active.teamId === expectedTeamId
    && verify('RSA-SHA256', Buffer.from(value.signingInput), publicKey, value.signature),
  )
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input)
  if (url.origin !== fixtureOrigin) return originalFetch(input, init)
  if (url.pathname !== '/org/me') return orgMeResponse(404, { code: 'NOT_FOUND' })
  const headers = new Headers(init?.headers)
  if (!validAssertion(assertion(headers.get('x-uoa-subject-assertion')))) {
    return orgMeResponse(403, { code: 'INVALID_SUBJECT_TOKEN' })
  }
  return orgMeResponse(200, {
    org: {
      org_id: expectedOrganizationId,
      org_role: 'owner',
      teams: [expectedTeamId],
    },
  })
}