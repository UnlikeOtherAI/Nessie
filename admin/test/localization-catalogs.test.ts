import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogs } from '../src/i18n/catalogs'
import { LANGUAGES } from '../src/i18n/languages'

const leafPaths = (value: unknown, prefix = ''): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

test('every supported language has the same registered catalog keys', () => {
  const expected = leafPaths(catalogs['en-GB']).sort()
  for (const { code } of LANGUAGES) {
    assert.deepEqual(leafPaths(catalogs[code]).sort(), expected, `${code} catalog keys`)
  }
})

test('language codes and native names are unique and include British English source', () => {
  assert.equal(new Set(LANGUAGES.map(({ code }) => code)).size, LANGUAGES.length)
  assert.equal(new Set(LANGUAGES.map(({ nativeName }) => nativeName)).size, LANGUAGES.length)
  assert.equal(LANGUAGES[0]?.code, 'en-GB')
  assert.ok(LANGUAGES.every(({ emoji }) => emoji.length > 0))
})
