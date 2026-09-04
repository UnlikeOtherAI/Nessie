import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsDetectedSecret,
  createSecretRedactingStream,
  detectSecrets,
  extractDetectedSecretValue,
  maskSecretValue,
  redactDetectedSecrets,
  redactDetectedSecretsInValue,
} from '../secret-scan.js'

test('containsDetectedSecret scans raw nested strings before JSON escaping', () => {
  const secret = `sk-ant-${'aB3_'.repeat(8)}`
  assert.equal(containsDetectedSecret({ notes: `first line\n${secret}\nlast line` }), true)
  assert.equal(containsDetectedSecret({ notes: 'ordinary nested text' }), false)
  const safe = redactDetectedSecretsInValue({ notes: `first line\n${secret}` })
  assert.equal(JSON.stringify(safe).includes(secret), false)
})

test('detectSecrets catches known credential formats without interpreting prose', () => {
  const stripeLikeToken = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const detected = detectSecrets(`prosim use ${stripeLikeToken} for platby`)
  assert.equal(detected.length, 1)
  assert.equal(detected[0]?.type, 'stripe_api_key')
  assert.equal(
    redactDetectedSecrets(`key=${stripeLikeToken}`),
    'key=[REDACTED_SECRET]',
  )
  assert.doesNotMatch(redactDetectedSecrets(stripeLikeToken), /1234567890/)
})

test('detectSecrets catches private key blocks and database URLs', () => {
  assert.equal(detectSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').length, 1)
  assert.equal(
    detectSecrets(
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----',
    ).length,
    1,
  )
  assert.equal(detectSecrets('postgresql://admin:really-secret@db.example/nessie').length, 1)
  assert.equal(detectSecrets('postgres://admin:pa/ssword@db.example/nessie').length, 1)
  assert.equal(detectSecrets('https://service:opaque-password@example.com/path').length, 1)
})

test('detectSecrets catches common provider prefixes and unprefixed high-entropy tokens', () => {
  const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const lettersOnly = 'aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmN'
  const detected = detectSecrets(
    `glpat-abcdefghijklmnopqrstuvwxyz123456 Xz9_kLm2Pq7Rs4Tu8Vw1Yz6Ab3Cd5Ef0 ${awsSecret} ${lettersOnly}`,
  )
  assert.equal(detected.length, 4)
  assert.equal(detected[0]?.type, 'github_token')
  assert.equal(detected[1]?.type, 'high_entropy_token')
  assert.equal(detected[2]?.type, 'high_entropy_token')
  assert.equal(detected[3]?.type, 'high_entropy_token')
  assert.doesNotMatch(redactDetectedSecrets(awsSecret), /EXAMPLEKEY/u)
  assert.equal(detectSecrets('sk-proj-abcdefghijkl')[0]?.type, 'openai_api_key')
  assert.equal(detectSecrets('sk_live_abcdefgh')[0]?.type, 'stripe_api_key')
  assert.equal(detectSecrets('whsec_abcdefghijkl')[0]?.type, 'stripe_api_key')
})

test('detectSecrets covers quoted assignments, bearer headers, and common secret fields', () => {
  const cases = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Basic dXNlcjpwYXNz',
    'Authorization: Token abc123',
    'Proxy-Authorization: ApiKey abc123',
    'Authorization: Digest username="u", response="abc123"',
    'client_secret="abcdefghijklmnopqrstuvwxyz123456"',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    "password: 'correct-horse-battery-staple'",
    'MY_API_KEY=abcdefghijklmnopqrstuvwxyz123456',
    'AWS_SESSION_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
    'STRIPE_WEBHOOK_SECRET=abcdefghijklmnopqrstuvwxyz123456',
    'STRIPE_SECRET_KEY=abcdefghijklmnopqrstuvwxyz123456',
    '{"client_secret":"abcdefghijklmnopqrstuvwxyz123456"}',
    '{"stripeSecretKey":"abcdefghijklmnopqrstuvwxyz123456"}',
    '{"token":["abcdefghijklmnopqrstuvwxyz123456"]}',
    'API_KEY=${abcdefghijklmnopqrstuvwxyz123456}',
    "API_KEY=$'abcdefghijklmnopqrstuvwxyz123456'",
    '{"client_secret":"abc\\\"defghijklmnopqrstuvwxyz123456"}',
    'password="hunter2"',
    'token=abc123',
    'pass=abc123',
    'passwd=abc123',
    'pwd=abc123',
    'secret key: abc123',
    'apikey hunter2',
    'password hunter2',
    '{\\"api_key\\":\\"hunter2\\"}',
  ]
  for (const value of cases) assert.equal(detectSecrets(value).length, 1, value)
})

test('detectSecrets covers Slack app tokens and truncated private-key pastes', () => {
  const slackAppToken = `xapp-${'a1B2-'.repeat(8)}`
  const partialKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123'

  assert.equal(detectSecrets(slackAppToken)[0]?.type, 'slack_token')
  assert.equal(detectSecrets(partialKey)[0]?.type, 'pem_private_key')
  assert.equal(
    redactDetectedSecrets(partialKey),
    '[REDACTED_SECRET]',
  )
})

test('a masked private-key prefix cannot conceal newly appended raw material', () => {
  const masked = `-----BEGIN PRIVATE KEY-----${'•'.repeat(12)}`
  const uppercaseBody = 'QUJDREVGR0JS1TVVWVYW1234QUJDREVGR0JS1TVVWVYW1234'
  assert.equal(detectSecrets(`${masked}raw-key-tail`).length, 1)
  assert.equal(
    detectSecrets(`${masked}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=`).length,
    1,
  )
  assert.equal(detectSecrets(`${masked}\n\n${uppercaseBody}`).length, 1)
  assert.equal(detectSecrets(`${masked}\nordinary prose`).length, 1)
  assert.equal(
    redactDetectedSecrets(`${masked}\nordinary prose`),
    '[REDACTED_SECRET]',
  )
})

test('a fixed bullet mask cannot camouflage appended credential bytes', () => {
  const mask = '•'.repeat(12)
  for (const value of [
    `api_key=${mask}hunter2`,
    `sk-proj-${mask}raw-tail`,
    `api_key=${mask} hunter2`,
    `Authorization: ${mask} hunter2`,
    `api_key=${mask} huntertwo`,
    `api_key=${mask} "hunter2"`,
    `api_key=${mask}\nhunter2`,
    `api_key=${mask}\nhuntertwo please use it`,
    `api_key=${mask} huntertwo please use it`,
    `api_key=${mask}: hunter2`,
    `api_key=${mask}\nok\nhunter2`,
    `api_key=${mask}\n123456`,
  ]) {
    const redacted = redactDetectedSecrets(value)
    assert.equal(detectSecrets(value).length, 1)
    assert.doesNotMatch(redacted, /hunter2|huntertwo|raw-tail|123456|please use it/u)
    assert.equal(detectSecrets(redacted).length, 0)
  }
  assert.equal(
    redactDetectedSecrets('password="abc•raw-tail"'),
    'password="[REDACTED_SECRET]"',
  )
  assert.equal(detectSecrets(`Protected: ${mask}.`).length, 0)
  assert.equal(
    redactDetectedSecrets(`OPENAI_API_KEY=sk-proj-${mask}\nSENDGRID_API_KEY=SG.${mask}`),
    `OPENAI_API_KEY=sk-proj-${mask}\nSENDGRID_API_KEY=SG.${mask}`,
  )
  assert.equal(
    redactDetectedSecrets(`OPENAI_API_KEY=sk-proj-${mask}\nSENDGRID_API_KEY=SG.${mask}\nhuntertwo`),
    'OPENAI_API_KEY=sk-proj-[REDACTED_SECRET]',
  )
})

test('provider-specific dotted and anthropic credentials are classified as one value', () => {
  const sendgrid = ['SG', 'abcdefghijklmnopqrstuv', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefg'].join('.')
  const anthropic = ['sk', 'ant', 'aA1_'.repeat(7)].join('-')

  assert.deepEqual(
    detectSecrets(`${sendgrid} ${anthropic}`).map(({ type }) => type),
    ['sendgrid_api_key', 'anthropic_api_key'],
  )
  assert.equal(redactDetectedSecrets(sendgrid), '[REDACTED_SECRET]')
})

test('display masks retain only structural provider prefixes', () => {
  assert.equal(
    maskSecretValue('sk-proj-secretbytes', 'openai_api_key'),
    `sk-proj-${'•'.repeat(12)}`,
  )
  assert.equal(
    redactDetectedSecrets('postgresql://admin:really-secret@db.example/nessie'),
    '[REDACTED_SECRET]',
  )
  assert.equal(
    redactDetectedSecrets('api_key=abcdefghijklmnopqrstuv'),
    'api_key=[REDACTED_SECRET]',
  )
  assert.equal(
    maskSecretValue('Xz9_kLm2Pq7Rs4Tu8Vw1Yz6Ab3Cd5Ef0', 'high_entropy_token'),
    '•'.repeat(12),
  )
})

test('explicit assignments save only the credential value', () => {
  const value = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const content = `api_key=${value}`
  const detected = detectSecrets(content)[0]
  assert.ok(detected)
  const extracted = extractDetectedSecretValue(content, detected)
  assert.equal(extracted, value)
  assert.equal(maskSecretValue(extracted, detected.type), `sk_live_${'•'.repeat(12)}`)
})

test('redaction is idempotent and never creates another detected secret', () => {
  const fixtures = [
    'api_key=abcdefghijklmnopqrstuv',
    'password="correct-horse-battery-staple"',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Basic dXNlcjpwYXNz',
    'client_secret=abcdefghijklmnopqrstuvwxyz123456,',
  ]
  for (const fixture of fixtures) {
    const redacted = redactDetectedSecrets(fixture)
    assert.equal(redactDetectedSecrets(redacted), redacted)
    assert.equal(detectSecrets(redacted).length, 0)
  }
  assert.equal(
    redactDetectedSecrets('Please deploy with API_KEY=abcdefghijklmnopqrstuv and report the result.'),
    'Please deploy with API_KEY=[REDACTED_SECRET] and report the result.',
  )
})

test('assignment extraction excludes surrounding quotes and prose punctuation', () => {
  const quoted = 'password="correct-horse-battery-staple"'
  const punctuated = 'client_secret=abcdefghijklmnopqrstuvwxyz123456,'
  const parenthesized = 'token=(abcdefghijklmnopqrstuvwxyz123456)'

  assert.equal(
    extractDetectedSecretValue(quoted, detectSecrets(quoted)[0]!),
    'correct-horse-battery-staple',
  )
  assert.equal(
    extractDetectedSecretValue(punctuated, detectSecrets(punctuated)[0]!),
    'abcdefghijklmnopqrstuvwxyz123456',
  )
  assert.equal(
    extractDetectedSecretValue(parenthesized, detectSecrets(parenthesized)[0]!),
    'abcdefghijklmnopqrstuvwxyz123456',
  )
  assert.equal(redactDetectedSecrets(parenthesized), 'token=([REDACTED_SECRET])')
  assert.equal(redactDetectedSecrets('password=pa$$word123'), 'password=[REDACTED_SECRET]')
  assert.equal(redactDetectedSecrets(String.raw`password=pa\ssword123`), 'password=[REDACTED_SECRET]')
})

test('stream redaction holds partial lines and private keys until they are safe', () => {
  const stream = createSecretRedactingStream()
  assert.equal(stream.push('before\napi_key=abc'), 'before\n')
  assert.equal(
    stream.push('defghijklmnopqrstuv\nafter\n'),
    'api_key=[REDACTED_SECRET]\nafter\n',
  )
  assert.equal(stream.finish(), '')

  const pemStream = createSecretRedactingStream()
  assert.equal(pemStream.push('-----BEGIN PRIVATE KEY-----\nabc\n'), '')
  assert.equal(
    pemStream.push('-----END PRIVATE KEY-----\n'),
    '[REDACTED_SECRET]\n',
  )

  const partialPemStream = createSecretRedactingStream()
  assert.equal(partialPemStream.push('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc'), '')
  assert.equal(
    partialPemStream.finish(),
    '[REDACTED_SECRET]',
  )

  const maskedPemStream = createSecretRedactingStream()
  const maskedPem = `-----BEGIN PRIVATE KEY-----${'•'.repeat(12)}`
  assert.equal(
    maskedPemStream.push(`${maskedPem}\nafter\n`),
    '[REDACTED_SECRET]',
  )
  assert.equal(maskedPemStream.push('QUJDREVGR0hJSktM\n'), '')
  assert.equal(maskedPemStream.finish(), '')

  const appendedPemStream = createSecretRedactingStream()
  assert.equal(appendedPemStream.push(`${maskedPem}\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n`), '')
  assert.equal(appendedPemStream.finish(), '[REDACTED_SECRET]')

  const blankSeparatedPemStream = createSecretRedactingStream()
  const uppercaseBody = 'QUJDREVGR0JS1TVVWVYW1234QUJDREVGR0JS1TVVWVYW1234'
  assert.equal(blankSeparatedPemStream.push(`${maskedPem}\n\n`), '')
  assert.equal(blankSeparatedPemStream.push(`${uppercaseBody}\n`), '')
  assert.equal(blankSeparatedPemStream.finish(), '[REDACTED_SECRET]')

  const camouflagedMaskStream = createSecretRedactingStream()
  assert.equal(camouflagedMaskStream.push(`api_key=${'•'.repeat(12)}\n`), '')
  assert.equal(
    camouflagedMaskStream.push('hunter2\n'),
    'api_key=[REDACTED_SECRET]',
  )
  assert.equal(camouflagedMaskStream.push('hunter2 again\n'), '')
  assert.equal(camouflagedMaskStream.finish(), '')
})
