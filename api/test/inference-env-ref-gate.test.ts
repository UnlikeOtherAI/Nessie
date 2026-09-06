import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  createInferenceCredentialBinding,
  InferenceEnvRefForbiddenError,
} from '../src/services/inference-credential-bindings.js'

// Phase-0 secret-custody gate (S2): every credential-binding create carries a
// caller-chosen env-ref, and the worker resolves it as process.env[ref] — so
// new writes are refused before any database access. Grandfathered rows are
// out of scope here: the gate must never run against existing rows.

const untouchablePrisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    throw new Error(`prisma.${String(prop)} accessed — the env-ref gate must refuse before any DB work`)
  },
})

const actorContext = {
  actor: { actorId: 'user-1', actorType: 'user' },
  tenant: { organizationId: 'org-1', projectId: 'proj-1', teamId: 'team-1' },
} as unknown as AuthorizedActionContext

test('a new caller-chosen env ref is refused before any database access', async () => {
  await assert.rejects(
    createInferenceCredentialBinding(untouchablePrisma, actorContext, {
      providerId: 'prov-1',
      authSecretRef: 'DATABASE_URL',
    } as Parameters<typeof createInferenceCredentialBinding>[2]),
    (error: unknown) => {
      assert.ok(error instanceof InferenceEnvRefForbiddenError)
      assert.equal(error.code, 'INFERENCE_ENV_REF_FORBIDDEN')
      return true
    },
  )
})
