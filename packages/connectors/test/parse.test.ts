import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ManifestParseError } from '../src/errors.js'
import { parseManifest } from '../src/parse.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const readFixture = (name: string): Promise<string> =>
  readFile(join(FIXTURES, name), 'utf8')

test('parseManifest reads JSON / YAML / MD into the same canonical object', async () => {
  const [jsonText, yamlText, mdText] = await Promise.all([
    readFixture('valid.json'),
    readFixture('valid.yaml'),
    readFixture('valid.md'),
  ])

  const fromJson = parseManifest(jsonText, 'json')
  const fromYaml = parseManifest(yamlText, 'yaml')
  const fromMd = parseManifest(mdText, 'md')

  assert.deepEqual(fromYaml, fromJson)
  assert.deepEqual(fromMd, fromJson)
})

test('parseManifest auto-detects format when no hint is provided', async () => {
  const jsonText = await readFixture('valid.json')
  const yamlText = await readFixture('valid.yaml')
  const mdText = await readFixture('valid.md')

  const fromJson = parseManifest(jsonText)
  const fromYaml = parseManifest(yamlText)
  const fromMd = parseManifest(mdText)

  assert.deepEqual(fromJson, fromYaml)
  assert.deepEqual(fromMd, fromYaml)
})

test('parseManifest accepts Buffer inputs', async () => {
  const jsonText = await readFixture('valid.json')
  const buffer = Buffer.from(jsonText, 'utf8')

  const parsed = parseManifest(buffer, 'json')
  const fromString = parseManifest(jsonText, 'json')

  assert.deepEqual(parsed, fromString)
})

test('parseManifest reports line/column for malformed JSON', async () => {
  const text = await readFixture('malformed.json')

  try {
    parseManifest(text, 'json')
    assert.fail('expected parseManifest to throw')
  } catch (cause) {
    assert.ok(cause instanceof ManifestParseError, 'expected ManifestParseError')
    assert.equal(cause.format, 'json')
    assert.ok(typeof cause.line === 'number' && cause.line >= 1)
    assert.ok(typeof cause.column === 'number' && cause.column >= 1)
  }
})

test('parseMarkdownManifest rejects manifests without frontmatter', () => {
  const text = '# no frontmatter here\njust a body\n'

  try {
    parseManifest(text, 'md')
    assert.fail('expected parseManifest to throw')
  } catch (cause) {
    assert.ok(cause instanceof ManifestParseError)
    assert.equal(cause.format, 'md')
    assert.match(cause.message, /frontmatter/)
  }
})

test('parseMarkdownManifest rejects manifests with no closing delimiter', () => {
  const text = '---\napiVersion: x\n# missing closing delimiter\n'

  try {
    parseManifest(text, 'md')
    assert.fail('expected parseManifest to throw')
  } catch (cause) {
    assert.ok(cause instanceof ManifestParseError)
    assert.equal(cause.format, 'md')
    assert.match(cause.message, /closing/)
  }
})
