import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { normalizeBundle } from '../src/normalize.js'
import { parseManifest } from '../src/parse.js'
import { validateManifestOrThrow } from '../src/validate.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const readFixture = (name: string): Promise<string> =>
  readFile(join(FIXTURES, name), 'utf8')

const loadBundle = async (file: string) => {
  const value = parseManifest(await readFixture(file))
  const result = validateManifestOrThrow(value)
  return result.bundle
}

test('normalizeBundle produces one record per declared tool', async () => {
  const bundle = await loadBundle('valid.json')

  const records = normalizeBundle(bundle)

  assert.equal(records.length, 1)
  const tool = records[0]!
  assert.equal(tool.id, 'echo')
  assert.equal(tool.toolName, 'echo')
  assert.equal(tool.bundleId, 'com.example.fixture')
  assert.equal(tool.bundleVersion, '1.0.0')
  assert.equal(tool.enabled, true)
  assert.deepEqual(tool.grant, {
    allowed: true,
    config: { timeoutMs: 5000 },
  })
})

test('normalizeBundle fills defaults for optional fields', async () => {
  const bundle = await loadBundle('valid.json')

  const records = normalizeBundle({
    ...bundle,
    tools: [
      {
        id: 'bare',
        toolName: 'bare',
        label: 'Bare',
        overview: 'Tool with no optional fields filled in.',
        source: 'custom',
        transport: 'direct',
        inputSchema: { type: 'object' },
      },
    ],
  })

  const tool = records[0]!
  assert.equal(tool.instructions, '')
  assert.equal(tool.enabled, true)
  assert.equal(tool.grant, null)
  assert.deepEqual(tool.basePrompt, { content: '', mergeMode: 'append' })
  assert.equal(tool.commonPrompt, null)
  assert.deepEqual(tool.tags, [])
  assert.deepEqual(tool.baseSearchTerms, [])
  assert.deepEqual(tool.allowSearchTerms, [])
  assert.equal(tool.createdBy, 'system')
  assert.equal(tool.owner, bundle.metadata.id)
})

test('normalized records have stable field order across runs', async () => {
  const bundle = await loadBundle('valid.json')

  const first = JSON.stringify(normalizeBundle(bundle))
  const second = JSON.stringify(normalizeBundle(bundle))

  assert.equal(first, second)
})

test('normalized records have the documented stable key order', async () => {
  const bundle = await loadBundle('valid.json')

  const tool = normalizeBundle(bundle)[0]!
  const expectedOrder = [
    'id',
    'bundleId',
    'bundleName',
    'bundleVersion',
    'toolName',
    'label',
    'overview',
    'instructions',
    'source',
    'transport',
    'transportConfig',
    'inputSchema',
    'enabled',
    'grant',
    'basePrompt',
    'commonPrompt',
    'tags',
    'baseSearchTerms',
    'allowSearchTerms',
    'createdBy',
    'owner',
  ]

  assert.deepEqual(Object.keys(tool), expectedOrder)
})

test('JSON / YAML / Markdown manifests normalize to identical records', async () => {
  const jsonBundle = await loadBundle('valid.json')
  const yamlBundle = await loadBundle('valid.yaml')
  const mdBundle = await loadBundle('valid.md')

  const fromJson = JSON.stringify(normalizeBundle(jsonBundle))
  const fromYaml = JSON.stringify(normalizeBundle(yamlBundle))
  const fromMd = JSON.stringify(normalizeBundle(mdBundle))

  assert.equal(fromYaml, fromJson)
  assert.equal(fromMd, fromJson)
})
