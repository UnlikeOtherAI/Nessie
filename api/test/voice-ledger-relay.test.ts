import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerIdentityService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  ledgerDeviceId,
  LedgerVoiceError,
  mintVoiceCredential,
  relayVoiceUsage,
} from '../src/services/voice/ledger-gemini-live.js'
import {
  transcribeVoiceDictation,
  VOICE_DICTATION_LEDGER_TIMEOUT_MS,
} from '../src/services/voice/ledger-google-speech.js'

const actorContext: AuthorizedActionContext = {
  actionContext: {
    requestId: 'request-voice-1',
    uoaIdentity: {
      organizationId: 'uoa-org',
      subject: 'uoa-sub',
      teamId: 'uoa-team',
      tokenVersion: 3,
    },
  },
  actor: { actorId: '00000000-0000-4000-8000-000000000001', actorType: 'user' },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
}

const env = {
  LEDGER_PUBLIC_URL: 'https://ledger.example.com/ignored/path',
  LEDGER_PROXY_TOKEN: 'proxy-token',
} as unknown as NodeJS.ProcessEnv

const identity: LedgerIdentityService = {
  requestHeaders: async () => ({
    'X-Nessie-Context': 'context-jwt',
    'X-UOA-Delegation': 'delegation-jwt',
  }),
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const credentialBody = {
  sessionId: 'ledger-session-1',
  accessToken: 'auth_tokens/abc',
  model: 'gemini-3.1-flash-live-preview',
  expiresAt: '2026-09-02T10:30:00.000Z',
  newSessionExpiresAt: '2026-09-02T10:00:45.000Z',
}

test('mint sends the app key plus signed identity, and only the identity headers', async () => {
  let captured: { url: string; headers: Headers; body: unknown } | null = null

  const credential = await mintVoiceCredential({
    actorContext,
    deviceId: 'device-hash',
    env,
    ledgerIdentity: identity,
    fetchImpl: (async (url, init) => {
      captured = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return jsonResponse(credentialBody)
    }) as never,
  })

  assert.ok(captured)
  // Only the ORIGIN of LEDGER_PUBLIC_URL is used: a configured path would
  // otherwise be prepended and silently 404.
  assert.equal(captured!.url, 'https://ledger.example.com/v1/gemini/live-token')
  assert.equal(captured!.headers.get('authorization'), 'Bearer proxy-token')
  assert.equal(captured!.headers.get('x-nessie-context'), 'context-jwt')
  assert.equal(captured!.headers.get('x-uoa-delegation'), 'delegation-jwt')
  assert.deepEqual(captured!.body, { deviceId: 'device-hash' })
  assert.equal(credential.sessionId, 'ledger-session-1')
  assert.equal(credential.accessToken, 'auth_tokens/abc')
  // Ledger named no socket, so the constrained endpoint is the fallback — the
  // only one an ephemeral credential may open.
  assert.match(credential.websocketUrl, /BidiGenerateContentConstrained$/u)
})

test('an unexpected identity header is a defect, not something to forward', async () => {
  await assert.rejects(
    mintVoiceCredential({
      actorContext,
      deviceId: 'device-hash',
      env,
      ledgerIdentity: {
        requestHeaders: async () => ({ 'X-Smuggled': 'value' }),
      },
      fetchImpl: (async () => jsonResponse(credentialBody)) as never,
    }),
    (error: unknown) =>
      error instanceof LedgerVoiceError && error.code === 'VOICE_LEDGER_IDENTITY_INVALID',
  )
})

test('with no signer configured the app key travels alone', async () => {
  let headers: Headers | null = null
  await mintVoiceCredential({
    actorContext,
    deviceId: 'device-hash',
    env,
    ledgerIdentity: null,
    fetchImpl: (async (_url, init) => {
      headers = new Headers(init?.headers)
      return jsonResponse(credentialBody)
    }) as never,
  })
  assert.ok(headers)
  assert.equal(headers!.get('authorization'), 'Bearer proxy-token')
  assert.equal(headers!.get('x-nessie-context'), null)
})

test("Ledger's own verdicts reach the caller; upstream faults do not", async () => {
  const forStatus = async (status: number): Promise<number> => {
    try {
      await mintVoiceCredential({
        actorContext,
        deviceId: 'device-hash',
        env,
        ledgerIdentity: identity,
        fetchImpl: (async () =>
          jsonResponse({ error: { message: 'nope' } }, status)) as never,
      })
      return 0
    } catch (error) {
      return error instanceof LedgerVoiceError ? error.status : -1
    }
  }

  // Budget, grants and concurrency are the caller's to act on.
  assert.equal(await forStatus(402), 402)
  assert.equal(await forStatus(403), 403)
  assert.equal(await forStatus(429), 429)
  // Anything else is an upstream fault and is not the caller's status.
  assert.equal(await forStatus(500), 502)
  assert.equal(await forStatus(418), 502)
})

test('a malformed credential is refused rather than handed to a client', async () => {
  await assert.rejects(
    mintVoiceCredential({
      actorContext,
      deviceId: 'device-hash',
      env,
      ledgerIdentity: identity,
      fetchImpl: (async () => jsonResponse({ sessionId: 'only-this' })) as never,
    }),
    (error: unknown) =>
      error instanceof LedgerVoiceError && error.code === 'VOICE_LEDGER_RESPONSE_INVALID',
  )
})

test('missing Ledger configuration is a 503, not a crash', async () => {
  await assert.rejects(
    mintVoiceCredential({
      actorContext,
      deviceId: 'device-hash',
      env: {} as NodeJS.ProcessEnv,
      ledgerIdentity: identity,
      fetchImpl: (async () => jsonResponse(credentialBody)) as never,
    }),
    (error: unknown) =>
      error instanceof LedgerVoiceError
      && error.code === 'VOICE_LEDGER_UNCONFIGURED'
      && error.status === 503,
  )
})

test('the device id is stable per installation and hides the row id', () => {
  const first = ledgerDeviceId('installation-1', 'secret')
  assert.equal(first, ledgerDeviceId('installation-1', 'secret'))
  assert.notEqual(first, ledgerDeviceId('installation-2', 'secret'))
  // A different deployment secret must not produce a colliding slot.
  assert.notEqual(first, ledgerDeviceId('installation-1', 'other-secret'))
  assert.ok(!first.includes('installation-1'))
})

test('the device id is a UUID, which is what Ledger accepts', () => {
  // Ledger validates `deviceId` as a UUID and rejects anything else with a
  // 400 — a bare hex digest looks fine locally and fails at the only place
  // that matters, so the shape is asserted here.
  const id = ledgerDeviceId('installation-1', 'secret')
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
})

test('usage relays the client sequence as Ledger\'s idempotency key', async () => {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null

  const result = await relayVoiceUsage({
    actorContext,
    env,
    ledgerIdentity: identity,
    ledgerSessionId: 'ledger-session-1',
    sequence: 7,
    model: 'gemini-3.1-flash-live-preview',
    usage: { totalTokens: 42 },
    complete: false,
    fetchImpl: (async (url, init) => {
      captured = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return jsonResponse({ acceptedSequence: 7, duplicate: false, complete: false })
    }) as never,
  })

  assert.ok(captured)
  assert.equal(
    captured!.url,
    'https://ledger.example.com/v1/gemini/live-sessions/ledger-session-1/usage',
  )
  // Ledger derives its key from (session, sequence): preserving the client's
  // number end to end is what makes a retried report a duplicate rather than
  // a second billed turn.
  assert.equal(captured!.headers.get('idempotency-key'), 'ledger-session-1:7')
  assert.equal(captured!.body['sequence'], 7)
  assert.equal('complete' in captured!.body, false)
  assert.deepEqual(result, { acceptedSequence: 7, duplicate: false, complete: false })
})

test('a superseded usage report surfaces as a conflict the client can drop', async () => {
  await assert.rejects(
    relayVoiceUsage({
      actorContext,
      env,
      ledgerIdentity: identity,
      ledgerSessionId: 'ledger-session-1',
      sequence: 2,
      model: 'm',
      usage: null,
      complete: true,
      fetchImpl: (async () => jsonResponse({ error: 'stale' }, 409)) as never,
    }),
    (error: unknown) => error instanceof LedgerVoiceError && error.status === 409,
  )
})

test('dictation uses the same signed private Ledger seam and preserves its idempotency key', async () => {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null
  const transcript = await transcribeVoiceDictation({
    actorContext,
    audioBase64: 'AAECAw==',
    env,
    idempotencyKey: '00000000-0000-4000-8000-000000000123',
    ledgerIdentity: identity,
    locale: 'en-GB',
    fetchImpl: (async (url, init) => {
      captured = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      }
      return jsonResponse({ transcript: 'Hello from dictation' })
    }) as never,
  })
  assert.equal(transcript, 'Hello from dictation')
  assert.ok(captured)
  assert.equal(captured!.url, 'https://ledger.example.com/v1/google-speech/transcriptions')
  assert.equal(captured!.headers.get('authorization'), 'Bearer proxy-token')
  assert.equal(captured!.headers.get('x-nessie-context'), 'context-jwt')
  assert.equal(captured!.headers.get('idempotency-key'), '00000000-0000-4000-8000-000000000123')
  assert.deepEqual(captured!.body, {
    audioBase64: 'AAECAw==',
    idempotencyKey: '00000000-0000-4000-8000-000000000123',
    locale: 'en-GB',
  })
})

test('dictation surfaces an ambiguous Ledger conflict and never fabricates a transcript', async () => {
  await assert.rejects(
    transcribeVoiceDictation({
      actorContext,
      audioBase64: 'AAECAw==',
      env,
      idempotencyKey: '00000000-0000-4000-8000-000000000124',
      ledgerIdentity: identity,
      fetchImpl: (async () => jsonResponse({ error: 'pending' }, 409)) as never,
    }),
    (error: unknown) => error instanceof LedgerVoiceError && error.status === 409,
  )
})

test('dictation supplies its 45-second Ledger deadline for a settled transcript', async () => {
  let suppliedTimeout: number | undefined
  const controller = new AbortController()
  const transcript = await transcribeVoiceDictation({
    actorContext,
    audioBase64: 'AAECAw==',
    env,
    idempotencyKey: '00000000-0000-4000-8000-000000000125',
    ledgerIdentity: identity,
    timeoutSignalFactory: (timeoutMs) => {
      suppliedTimeout = timeoutMs
      return controller.signal
    },
    fetchImpl: (async (_url, init) => {
      assert.equal(init?.signal?.aborted, false)
      return jsonResponse({ transcript: 'Settled text' })
    }) as never,
  })

  assert.equal(suppliedTimeout, VOICE_DICTATION_LEDGER_TIMEOUT_MS)
  assert.ok(VOICE_DICTATION_LEDGER_TIMEOUT_MS > 15_000)
  assert.equal(transcript, 'Settled text')
})
