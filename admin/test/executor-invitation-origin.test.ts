import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { resolveExecutorApiOrigin } from '../src/lib/api-client.js'
import { resolveExecutorApiPublicUrl } from '../vite.config.js'

const readSource = (path: string): string => readFileSync(resolve(import.meta.dirname, path), 'utf8')

test('executor invitations use the direct API origin Vite config supplies', () => {
  assert.equal(resolveExecutorApiOrigin('http://127.0.0.1:5454'), 'http://127.0.0.1:5454')
  assert.equal(
    resolveExecutorApiOrigin('https://api.nessie.works/ignored-path'),
    'https://api.nessie.works',
  )
  assert.throws(() => resolveExecutorApiOrigin(), /VITE_API_PUBLIC_URL/)
})

test('terminal and desktop companion pairing share the executor API-origin contract', () => {
  for (const path of [
    '../src/pages/ExecutorsPage.tsx',
    '../src/components/features/executors/ExecutorDesktopCompanionPanel.tsx',
  ]) {
    const source = readSource(path)
    assert.match(source, /getExecutorApiOrigin\(created\.invitation\.apiBaseUrl\)/)
    assert.doesNotMatch(source, /https:\/\/api\.nessie\.works/)
  }
})

test('Vite exports an operator API origin for executor invitations', () => {
  assert.equal(
    resolveExecutorApiPublicUrl({
      NESSIE_API_PUBLIC_URL: 'https://operator-api.example.test',
      VITE_API_PUBLIC_URL: 'https://build-api.example.test',
    }, '5454', false),
    'https://operator-api.example.test',
  )
  assert.equal(
    resolveExecutorApiPublicUrl({ VITE_API_PUBLIC_URL: 'https://build-api.example.test' }, '5454', false),
    'https://build-api.example.test',
  )
  assert.equal(
    resolveExecutorApiPublicUrl({ VITE_API_BASE_URL: 'https://api.nessie.works' }, '5454', false),
    'https://api.nessie.works',
  )
  assert.equal(resolveExecutorApiPublicUrl({}, '5454', true), 'http://127.0.0.1:5454')
  assert.equal(resolveExecutorApiPublicUrl({}, '5454', false), undefined)
})
