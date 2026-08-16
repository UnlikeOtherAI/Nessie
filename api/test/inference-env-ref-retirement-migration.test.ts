import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The phase-0 gate (`inference-env-ref-gate.test.ts`) only refuses NEW
 * `auth_secret_ref` writes. Every row written before it still resolved as
 * `process.env[ref]` in the worker and went out as a bearer to an
 * organisation-owner-chosen endpoint, so the grandfathered rows are retired by
 * migration rather than guarded a second time.
 */

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260816090000_retire_grandfathered_inference_env_refs/migration.sql',
  ),
  'utf8',
)

test('every surviving binding is revoked and detached from its provider', () => {
  assert.match(
    migrationSql,
    /UPDATE "inference_credential_bindings"[\s\S]*SET "revoked_at" = now\(\)[\s\S]*WHERE "revoked_at" IS NULL/,
  )
  assert.match(
    migrationSql,
    /UPDATE "inference_providers"[\s\S]*SET "active_credential_binding_id" = NULL/,
  )
  // Detach comes after revoke, so no window leaves a live provider pointing at
  // a revoked binding.
  assert.ok(
    migrationSql.indexOf('SET "revoked_at" = now()')
      < migrationSql.indexOf('SET "active_credential_binding_id" = NULL'),
  )
})

test('an OpenAI-compatible provider left without a credential fails loudly, not at run time', () => {
  assert.match(
    migrationSql,
    /SET "enabled" = false,[\s\S]*"health_status" = 'unreachable',[\s\S]*"lifecycle_status" = 'draft'/,
  )
  assert.match(
    migrationSql,
    /WHERE "connector_kind" = 'openai-compatible'[\s\S]*AND "active_credential_binding_id" IS NULL/,
  )
  // The disable must run after the detach, or it matches nothing.
  assert.ok(
    migrationSql.indexOf('SET "active_credential_binding_id" = NULL')
      < migrationSql.indexOf(`SET "enabled" = false`),
  )
})

test('the migration states the operator impact it causes', () => {
  assert.match(migrationSql, /OPERATOR IMPACT/)
  assert.match(migrationSql, /deployment-level/)
  assert.match(migrationSql, /INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING/)
})

test('the worker refuses to resolve a revoked binding on the reading side too', () => {
  const workerSql = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../worker/src/run/inference-provider.ts',
    ),
    'utf8',
  )
  assert.match(
    workerSql,
    /LEFT JOIN inference_credential_bindings b[\s\S]*ON b\.id = p\.active_credential_binding_id[\s\S]*AND b\.revoked_at IS NULL/,
  )
})
