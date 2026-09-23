import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  canonicalExecutorPayload,
  ExecutorDaemonCommandAttachmentRequestSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { ExecutorApiError } from '../src/api-client.js'
import {
  createExecutorCommandAttachmentStore,
  deliverExecutorCommandAttachments,
  executorAttachmentUploadTimeoutMs,
  sweepExecutorCommandAttachments,
  type ExecutorAttachmentUpload,
  type ExecutorCommandAttachmentStore,
} from '../src/command-attachments.js'
import {
  recoverOrPollExecutorCommand,
  type ExecutorCommandRecovery,
  type ExecutorCommandRecoveryStore,
} from '../src/command-recovery.js'
import { uploadExecutorCommandAttachment } from '../src/daemon.js'
import { executeExecutorMcpCommand } from '../src/mcp-dispatch.js'
import { executorMcpImageReferences, extractExecutorMcpImages } from '../src/mcp-images.js'
import { createExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import type { ExecutorLocalState } from '../src/state-store.js'

/**
 * The daemon half of a screenshot's journey, on a real disk: sidecars written
 * and fsynced before the journal entry that references them, uploaded before
 * the receipt, re-uploaded after a crash, withdrawn — never retried — when
 * Nessie refuses one, and swept at start. The control plane is a fake that
 * behaves as the attachment route is specified to: it keeps one attachment per
 * command and digest, however often the same one arrives.
 */

const SCRIPT = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))
const EXAMPLE_DIGEST = 'sha256:aac8eca7b74f38470cd961da4b11897e2296ca4b583865dde161ab387027e7a5'

const command: ExecutorCommandEnvelope = {
  argumentDigest: `sha256:${'1'.repeat(64)}`,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000602',
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000603',
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'command-attachments-test',
  operationKey: 'mcp.call',
  payload: { args: { server: 'kelpie', tool: 'kelpie_screenshot' }, runId: '00000000-0000-4000-8000-000000000601' },
}

const withRuntime = async (body: (stateDir: string, sidecars: ExecutorCommandAttachmentStore) => Promise<void>) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-command-attachments-'))
  try {
    // The owner-only proof of the runtime directory is host-shaped (a native
    // helper on Windows); what is under test is everything beneath it.
    const sidecars = createExecutorCommandAttachmentStore(stateDir, {
      ensureRuntimeDirectory: async (directory) => {
        const runtime = join(directory, 'runtime')
        await mkdir(runtime, { recursive: true })
        return runtime
      },
    })
    await body(stateDir, sidecars)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
}

const digestsIn = (result: Record<string, unknown>): string[] =>
  executorMcpImageReferences(result).map((reference) => reference.attachmentDigest)

const sidecarPath = (stateDir: string, commandId: string, digest: string): string =>
  join(stateDir, 'runtime', 'attachments', commandId, `${digest.slice('sha256:'.length)}.bin`)

const memoryJournal = (initial: ExecutorCommandRecovery | null = null) => {
  let value = initial
  const saved: ExecutorCommandRecovery[] = []
  const store: ExecutorCommandRecoveryStore = {
    clear: async () => { value = null },
    load: async () => value,
    save: async (next) => {
      saved.push(structuredClone(next))
      value = structuredClone(next)
    },
  }
  return { read: () => value, saved, store }
}

/** The attachment route as specified: one attachment per (command, digest), 4xx refusals. */
const fakeControlPlane = (options: { refuseWith?: ExecutorApiError; failWith?: () => Error } = {}) => {
  const stored = new Map<string, Buffer>()
  const uploads: string[] = []
  const receipts: Record<string, unknown>[] = []
  let failures = 0
  const upload: ExecutorAttachmentUpload = async (image) => {
    uploads.push(image.digest)
    if (options.refuseWith) throw options.refuseWith
    if (options.failWith && failures === 0) {
      failures += 1
      throw options.failWith()
    }
    assert.equal(`sha256:${createHash('sha256').update(image.bytes).digest('hex')}`, image.digest)
    stored.set(`${image.commandId}:${image.digest}`, Buffer.from(image.bytes))
  }
  return { receipts, stored, upload, uploads }
}

const recover = (input: {
  journal: ExecutorCommandRecoveryStore
  loseReceipt?: () => boolean
  receipts: Record<string, unknown>[]
  sidecars: ExecutorCommandAttachmentStore
  upload: ExecutorAttachmentUpload
  execute?: () => Promise<Record<string, unknown>>
}) => {
  let delivered = false
  return recoverOrPollExecutorCommand({
    attachments: {
      deliver: (pending) => deliverExecutorCommandAttachments({
        ...pending,
        sidecars: input.sidecars,
        upload: input.upload,
      }),
      release: (commandId) => input.sidecars.remove(commandId),
    },
    execute: input.execute ?? (async () => ({ success: true })),
    store: input.journal,
    transport: {
      poll: async () => {
        if (delivered) return null
        delivered = true
        return command
      },
      receipt: async (receipt) => {
        if (receipt.state !== 'result_acknowledged') return
        if (input.loseReceipt?.()) throw new Error('the daemon stopped before the receipt')
        input.receipts.push(receipt.result ?? {})
      },
    },
  })
}

/** Kelpie's real screenshot answer (see mcp-images.test.ts). */
const kelpieResult = async (): Promise<Record<string, unknown>> => JSON.parse(
  await readFile(new URL('./fixtures/kelpie-screenshot-result.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/** A journal already at `result_pending` for Kelpie's screenshot, with its sidecar on disk. */
const pendingScreenshot = async (sidecars: ExecutorCommandAttachmentStore) => {
  const extracted = extractExecutorMcpImages(await kelpieResult())
  await sidecars.write(command.commandId, extracted.images)
  const result = { ...extracted.result, success: true }
  return memoryJournal({ command, phase: 'result_pending', result, version: 1 })
}

test('a real screenshot’s sidecar is on disk before the result that references it is journaled', async () => {
  await withRuntime(async (stateDir, sidecars) => {
    const sessions = createExecutorMcpSessionManager([{
      command: [process.execPath, SCRIPT],
      env: { NESSIE_TEST_MCP_MODE: 'kelpie' },
      name: 'kelpie',
    }], { maxResultBytes: 65_536 }, { log: () => undefined, startTimeoutMs: 15_000 })
    const journal = memoryJournal()
    const checkedAtJournal: string[] = []
    const store: ExecutorCommandRecoveryStore = {
      ...journal.store,
      save: async (next) => {
        if (next.phase === 'result_pending' && next.result) {
          for (const reference of executorMcpImageReferences(next.result)) {
            // Read from disk at the moment the entry is saved, not afterwards.
            const bytes = await readFile(sidecarPath(stateDir, next.command.commandId, reference.attachmentDigest))
            assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, reference.attachmentDigest)
            checkedAtJournal.push(reference.attachmentDigest)
          }
        }
        await journal.store.save(next)
      },
    }
    const api = fakeControlPlane()
    try {
      await recover({
        execute: () => executeExecutorMcpCommand(
          'mcp.call', command.payload.args, sessions, undefined, (images) => sidecars.write(command.commandId, images),
        ),
        journal: store,
        receipts: api.receipts,
        sidecars,
        upload: api.upload,
      })
    } finally {
      await sessions.stopAll()
    }

    assert.deepEqual(checkedAtJournal, [EXAMPLE_DIGEST])
    assert.deepEqual(api.uploads, [EXAMPLE_DIGEST], 'uploaded once, before the receipt')
    assert.equal(api.stored.get(`${command.commandId}:${EXAMPLE_DIGEST}`)?.length, 13_715)
    assert.equal(api.receipts.length, 1)
    assert.deepEqual(digestsIn(api.receipts[0]!), [EXAMPLE_DIGEST])
    assert.equal(journal.read(), null)
    assert.deepEqual(await readdir(join(stateDir, 'runtime', 'attachments')), [], 'an acknowledged receipt removes its sidecars')
  })
})

test('a restart between the upload and the receipt uploads again, and Nessie keeps one attachment', async () => {
  await withRuntime(async (stateDir, sidecars) => {
    const journal = await pendingScreenshot(sidecars)
    const api = fakeControlPlane()
    let receiptsSeen = 0
    const run = () => recover({
      journal: journal.store,
      loseReceipt: () => (receiptsSeen += 1) === 1,
      receipts: api.receipts,
      sidecars,
      upload: api.upload,
    })

    await assert.rejects(run(), /the daemon stopped before the receipt/)
    assert.equal(journal.read()?.phase, 'result_pending', 'the journal still holds the result')
    await readFile(sidecarPath(stateDir, command.commandId, EXAMPLE_DIGEST))
    await run()

    assert.deepEqual(api.uploads, [EXAMPLE_DIGEST, EXAMPLE_DIGEST])
    assert.equal(api.stored.size, 1)
    assert.equal(api.receipts.length, 1)
    assert.equal(journal.read(), null)
    await assert.rejects(readFile(sidecarPath(stateDir, command.commandId, EXAMPLE_DIGEST)), { code: 'ENOENT' })
  })
})

test('a refused upload is terminal: the reference becomes a placeholder, journaled before the receipt, and is never sent again', async () => {
  await withRuntime(async (_stateDir, sidecars) => {
    const journal = await pendingScreenshot(sidecars)
    const api = fakeControlPlane({
      refuseWith: new ExecutorApiError('Storage quota exceeded.', { code: 'STORAGE_QUOTA_EXCEEDED', status: 413 }),
    })
    // What the journal held at the moment each receipt was attempted.
    const journaledAtReceipt: unknown[] = []
    const run = () => recover({
      journal: journal.store,
      loseReceipt: () => {
        journaledAtReceipt.push(structuredClone(journal.read()?.result))
        return journaledAtReceipt.length === 1
      },
      receipts: api.receipts,
      sidecars,
      upload: api.upload,
    })

    await assert.rejects(run(), /the daemon stopped before the receipt/)
    const placeholder = '[image unavailable: Nessie refused it (Storage quota exceeded.)]'
    const journaled = journaledAtReceipt[0] as {
      content: Array<Record<string, unknown>>
      structuredContent: Record<string, unknown>
    }
    assert.deepEqual(journaled.content[1], { text: placeholder, type: 'text' })
    assert.equal((JSON.parse(journaled.content[0]!.text as string) as { image: string }).image, placeholder)
    assert.equal(journaled.structuredContent.image, placeholder)
    assert.equal(JSON.stringify(journaled).includes(EXAMPLE_DIGEST), false, 'no marker names the refused image')

    await run()
    assert.deepEqual(api.uploads, [EXAMPLE_DIGEST], 'the refused upload is never made again')
    // The receipt carries exactly what was journaled, so its digest is of the rewritten result.
    assert.deepEqual(api.receipts, [journaled])
    assert.equal(journal.read(), null)
  })
})

for (const [name, error] of [
  ['a 5xx', () => new ExecutorApiError('Executor API request failed (503).', { status: 503 })],
  ['a timeout', () => new ExecutorApiError('Executor API request timed out.', { code: 'EXECUTOR_API_TIMEOUT' })],
  ['a fenced connection', () => new ExecutorApiError('Connection fenced.', { code: 'EXECUTOR_CONNECTION_FENCED', status: 409 })],
  ['a rate limit', () => new ExecutorApiError('Too many uploads.', { code: 'RATE_LIMITED', status: 429 })],
] as const) {
  test(`${name} is not a refusal: the same journal delivers again on the next poll`, async () => {
    await withRuntime(async (_stateDir, sidecars) => {
      const journal = await pendingScreenshot(sidecars)
      const before = structuredClone(journal.read())
      const api = fakeControlPlane({ failWith: error })
      const run = () => recover({ journal: journal.store, receipts: api.receipts, sidecars, upload: api.upload })

      await assert.rejects(run(), (thrown: unknown) => thrown instanceof ExecutorApiError)
      assert.deepEqual(journal.read(), before, 'nothing was withdrawn')
      assert.equal(api.receipts.length, 0, 'no receipt before its images')
      await run()
      assert.deepEqual(api.uploads, [EXAMPLE_DIGEST, EXAMPLE_DIGEST])
      assert.deepEqual(digestsIn(api.receipts[0]!), [EXAMPLE_DIGEST])
    })
  })
}

test('a sidecar that is gone or altered is withdrawn as lost, and nothing is uploaded', async () => {
  for (const damage of ['delete', 'alter'] as const) {
    await withRuntime(async (stateDir, sidecars) => {
      const journal = await pendingScreenshot(sidecars)
      const path = sidecarPath(stateDir, command.commandId, EXAMPLE_DIGEST)
      if (damage === 'delete') await rm(path)
      else await writeFile(path, Buffer.from('not the screenshot'))
      const api = fakeControlPlane()
      await recover({ journal: journal.store, receipts: api.receipts, sidecars, upload: api.upload })

      assert.deepEqual(api.uploads, [])
      const content = (api.receipts[0] as { content: Array<Record<string, unknown>> }).content
      assert.equal(content[1]!.text, '[image unavailable: the image was lost on this machine before it could be delivered]', damage)
    })
  }
})

test('the daemon’s start removes every sidecar folder but the one the journal still names', async () => {
  await withRuntime(async (stateDir, sidecars) => {
    const { images } = extractExecutorMcpImages(await kelpieResult())
    const others = ['00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702']
    for (const commandId of [command.commandId, ...others]) await sidecars.write(commandId, images)
    const folder = join(stateDir, 'runtime', 'attachments')

    // A journal that cannot be read says nothing about which folder is current.
    await assert.rejects(sweepExecutorCommandAttachments({
      load: async () => { throw new Error('Executor command recovery journal is malformed.') },
    }, sidecars), /malformed/)
    assert.equal((await readdir(folder)).length, 3)

    await sweepExecutorCommandAttachments(memoryJournal({ command, phase: 'executing', version: 1 }).store, sidecars)
    assert.deepEqual(await readdir(folder), [command.commandId])

    await sweepExecutorCommandAttachments(memoryJournal().store, sidecars)
    assert.deepEqual(await readdir(folder), [])
  })
})

test('a sidecar path is built only from a command id and a digest', async () => {
  await withRuntime(async (_stateDir, sidecars) => {
    await assert.rejects(sidecars.write('../outside', []))
    await assert.rejects(sidecars.read(command.commandId, 'sha256:../../x'), /names no sidecar/)
    assert.equal(await sidecars.read(command.commandId, EXAMPLE_DIGEST), null)
  })
})

test('an upload is signed under the attachment domain and matches the request contract', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const state = {
    apiBaseUrl: 'https://nessie.example.test',
    connectionEpoch: '42',
    executorId: '00000000-0000-4000-8000-000000000600',
    machinePrivateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  } as unknown as ExecutorLocalState
  const sent: Array<{ baseUrl: string; input: Record<string, unknown>; timeoutMs: number }> = []
  const image = extractExecutorMcpImages(await kelpieResult()).images[0]!

  await uploadExecutorCommandAttachment(state, {
    uploadCommandAttachment: async (baseUrl, input, options) => {
      sent.push({ baseUrl, input, timeoutMs: options.timeoutMs })
      return { recorded: true }
    },
  })({ bytes: image.bytes, commandId: command.commandId, digest: image.digest, mimeType: image.mimeType })

  assert.equal(sent.length, 1)
  const request = ExecutorDaemonCommandAttachmentRequestSchema.parse(sent[0]!.input)
  assert.equal(sent[0]!.baseUrl, state.apiBaseUrl)
  assert.equal(sent[0]!.timeoutMs, executorAttachmentUploadTimeoutMs(13_715))
  assert.deepEqual(
    { ...request.attachment, occurredAt: 'x' },
    { byteLength: 13_715, commandId: command.commandId, digest: EXAMPLE_DIGEST, mimeType: 'image/png', occurredAt: 'x' },
  )
  assert.ok(Buffer.from(request.dataBase64, 'base64').equals(image.bytes))
  const signed = { attachment: request.attachment, connectionEpoch: '42', executorId: state.executorId }
  assert.equal(verify(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.attachment.v1', signed)),
    publicKey,
    Buffer.from(request.signature, 'base64url'),
  ), true)
  // The bytes are not what is signed: the digest is, and the server recomputes it.
  assert.equal(verify(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.receipt.v1', signed)),
    publicKey,
    Buffer.from(request.signature, 'base64url'),
  ), false, 'a receipt signature cannot stand in for an upload')
})
