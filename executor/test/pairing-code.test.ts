import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import test from 'node:test'

import { canonicalExecutorPayload, ExecutorScopeSchema, type ExecutorPairingClaim } from '@nessie/schemas'

import { createPairingCodeClient } from '../src/pairing-code.js'
import type { PendingPairingCode } from '../src/pairing-code-store.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const executorId = '00000000-0000-4000-8000-000000000001'
const pairingId = '00000000-0000-4000-8000-000000000002'
const fingerprint = `sha256:${'a'.repeat(64)}`
const claim: ExecutorPairingClaim = {
  executorId, machineName: 'My computer', organization: { id: 'org', name: 'Acme' },
  team: { id: 'team', name: 'Platform' },
  scope: ExecutorScopeSchema.parse({ kind: 'private', organizationId: '00000000-0000-4000-8000-000000000003' }),
  claimDigest: `sha256:${'b'.repeat(64)}`,
}

const fixture = () => {
  let pending: PendingPairingCode | null = null
  let state: ExecutorLocalState | null = null
  let stage = 'waiting'
  let loseStart = false
  let failRetirement = false
  let loseConfirm = false
  let pairingLocked = false
  let mintGate: Promise<void> | null = null
  let workspaceHasArtifacts = false
  const events: string[] = []
  const requests: Record<string, unknown>[] = []
  const client = createPairingCodeClient({
    assertWorkspaceMayChange: async () => {
      if (workspaceHasArtifacts) throw new Error('Resolve local drafts first')
    },
    acquirePairingLease: async () => {
      if (pairingLocked) throw new Error('pairing busy')
      pairingLocked = true
      return { release: async () => { pairingLocked = false } }
    },
    acquireExecutorDaemonLease: async () => ({ release: async () => undefined }),
    configureExecutorWorkspaceFolders: async (folders) => [...folders],
    loadPairingCode: async () => pending,
    savePairingCode: async (_directory, value) => { events.push('persist'); pending = structuredClone(value) },
    clearPairingCode: async () => { pending = null },
    loadExecutorState: async () => {
      if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return state
    },
    saveExecutorState: async (_directory, value) => { state = value },
    clearExecutorState: async () => {
      if (failRetirement) { failRetirement = false; throw new Error('local write failed') }
      events.push('clear-old'); state = null
    },
    postPairing: async (_origin, action, value) => {
      const request = value as Record<string, unknown>
      events.push(action)
      requests.push(request)
      const key = pending?.machinePrivateKey ?? state?.machinePrivateKey
      assert.ok(key, 'key must be durable before any network call')
      const { signature, replacementSignature, ...payload } = request
      assert.ok(verify(null, Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
        createPublicKey(createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' })),
        Buffer.from(signature as string, 'base64url')))
      if (replacementSignature) {
        assert.ok(state)
        assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.pairing.replace.v1', payload)),
          createPublicKey(createPrivateKey({ key: Buffer.from(state.machinePrivateKey, 'base64url'), format: 'der', type: 'pkcs8' })),
          Buffer.from(replacementSignature as string, 'base64url')))
      }
      if (action === 'start') {
        if (mintGate) await mintGate
        if (loseStart) { loseStart = false; throw new Error('response lost') }
        return { pairingId, code: '01234567', fingerprint, expiresAt: '2099-01-01T00:00:00.000Z', pollIntervalSeconds: 3 }
      }
      if (action === 'connection') return claim
      if (action === 'confirm') {
        stage = 'confirmed'
        if (loseConfirm) { loseConfirm = false; throw new Error('confirmation response lost') }
      }
      return { status: stage, pairingId, fingerprint, expiresAt: '2099-01-01T00:00:00.000Z',
        ...(stage === 'waiting' ? {} : { claim }) }
    },
  })
  return {
    client, events, requests, pending: () => pending, state: () => state,
    claim: () => { stage = 'awaiting_confirmation' }, loseResponse: () => { loseStart = true },
    wait: () => { stage = 'waiting' },
    expire: () => { stage = 'expired' },
    reject: () => { stage = 'rejected' },
    failRetirement: () => { failRetirement = true },
    loseConfirmation: () => { loseConfirm = true },
    holdMint: () => {
      let release!: () => void
      mintGate = new Promise<void>((done) => { release = done })
      return release
    },
    retainDrafts: () => { workspaceHasArtifacts = true },
  }
}

const input = { apiBaseUrl: 'https://api.nessie.works', stateDir: '/state', workspaceFolders: [{ name: 'work', path: '/work' }] }

test('pairing preserves the key through response loss and requires the displayed organisation claim before activation', async () => {
  const f = fixture()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  const key = f.pending()?.machinePrivateKey
  const requestId = f.pending()?.request.requestId
  const waiting = await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(waiting.code, '01234567')
  assert.equal(f.pending()?.machinePrivateKey, key)
  assert.equal(f.pending()?.request.requestId, requestId)
  assert.equal(f.state(), null)
  f.claim()
  const view = await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(view.organizationName, 'Acme')
  assert.equal(view.teamName, 'Platform')
  assert.equal(f.state(), null, 'claiming the code alone cannot activate the daemon')
  await assert.rejects(f.client.confirmPairingCode(input.stateDir, `sha256:${'c'.repeat(64)}`), /changed/)
  assert.ok(!f.events.includes('confirm'))
  await f.client.confirmPairingCode(input.stateDir, view.claimDigest!)
  assert.equal(f.state()?.executorId, executorId)
  assert.deepEqual(f.state()?.commandPolicy, { mode: 'all', allowlist: [], denylist: [] })
  assert.equal(Object.hasOwn(f.state()!.descriptor, 'commandPolicy'), false)
  assert.ok(f.requests.every((request) => !JSON.stringify(request).includes('"commandPolicy"')))
  assert.equal(f.pending(), null)
  assert.equal(Object.hasOwn(f.state()!, 'organizationName'), false)
})

test('replacement signs with both keys and retains the old key until retirement is acknowledged', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.confirmPairingCode(input.stateDir, claim.claimDigest)
  const oldKey = f.state()?.machinePrivateKey
  f.wait()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /response lost/)
  assert.equal(f.state()?.machinePrivateKey, oldKey)
  assert.notEqual(f.pending()?.machinePrivateKey, oldKey)
  assert.equal(f.pending()?.request.replacesExecutorId, executorId)
  await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(f.state(), null)
  assert.ok(f.events.lastIndexOf('persist') < f.events.lastIndexOf('clear-old'))
  await f.client.cancelPairingCode(input.stateDir)
  assert.ok(f.events.includes('cancel'))
  assert.equal(f.pending(), null)
})

test('pairing cancellation recovers a lost mint response and expired attempts can be restarted', async () => {
  const f = fixture()
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  await f.client.cancelPairingCode(input.stateDir)
  assert.equal(f.pending(), null)
  assert.equal(f.events.filter((event) => event === 'start').length, 2)
  assert.ok(f.events.includes('cancel'))
  await f.client.startPairingCode(input)
  f.expire()
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'expired')
  await f.client.cancelPairingCode(input.stateDir)
  f.wait()
  assert.equal((await f.client.startPairingCode(input)).status, 'waiting')
})

test('replacement recovers a persisted mint before old state cleanup and a lost confirmation response', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.confirmPairingCode(input.stateDir, claim.claimDigest)
  f.wait()
  f.failRetirement()
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /local write failed/)
  assert.ok(f.pending()?.response)
  assert.ok(f.state())
  await f.client.pairingCodeStatus(input.stateDir)
  assert.equal(f.state(), null)
  f.claim()
  f.loseConfirmation()
  await assert.rejects(f.client.confirmPairingCode(input.stateDir, claim.claimDigest), /confirmation response lost/)
  assert.equal(f.state(), null)
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'paired')
  assert.equal(f.state()?.executorId, executorId)
  assert.equal(f.pending(), null)
})

test('pairing detects the existing organisation and refuses silently changing its Nessie service', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.confirmPairingCode(input.stateDir, claim.claimDigest)
  const existing = await f.client.startPairingCode(input)
  assert.equal(existing.status, 'alreadyPaired')
  assert.equal(existing.organizationName, 'Acme')
  assert.equal(f.pending(), null)
  await assert.rejects(f.client.startPairingCode({
    ...input, apiBaseUrl: 'https://api.deeptest.live', replace: true,
  }), /same Nessie service/)
  assert.equal(f.pending(), null)
  assert.ok(f.state())
})

test('pairing serializes concurrent commands before reading or replacing pending keys', async () => {
  const f = fixture()
  const release = f.holdMint()
  const first = f.client.startPairingCode(input)
  await new Promise((done) => setImmediate(done))
  await assert.rejects(f.client.startPairingCode(input), /pairing busy/)
  release()
  await first
  await f.client.startPairingCode(input)
  assert.equal(f.events.filter((event) => event === 'start').length, 1)
})

test('replacement refuses retained workspace artifacts before revoking or generating another key', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.claim()
  await f.client.confirmPairingCode(input.stateDir, claim.claimDigest)
  const oldKey = f.state()?.machinePrivateKey
  f.retainDrafts()
  const priorEvents = [...f.events]
  await assert.rejects(f.client.startPairingCode({ ...input, replace: true }), /local drafts/)
  assert.deepEqual(f.events, priorEvents)
  assert.equal(f.state()?.machinePrivateKey, oldKey)
  assert.equal(f.pending(), null)
})

test('pairing clears a server-rejected attempt and retires a lost mint response after expiry', async () => {
  const f = fixture()
  await f.client.startPairingCode(input)
  f.reject()
  assert.equal((await f.client.pairingCodeStatus(input.stateDir)).status, 'cancelled')
  assert.equal(f.pending(), null)
  f.loseResponse()
  await assert.rejects(f.client.startPairingCode(input), /response lost/)
  f.expire()
  await f.client.cancelPairingCode(input.stateDir)
  assert.equal(f.pending(), null)
  f.wait()
  assert.equal((await f.client.startPairingCode(input)).status, 'waiting')
})
