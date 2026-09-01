import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPrefixTsQuery } from '../src/fts.js'

describe('buildPrefixTsQuery', () => {
  it('prefix-matches every term so partial words hit', () => {
    assert.equal(buildPrefixTsQuery('tick'), 'tick:*')
    assert.equal(buildPrefixTsQuery('open tick'), 'open:* & tick:*')
  })

  it('lowercases and collapses whitespace', () => {
    assert.equal(buildPrefixTsQuery('  Deploy   PLAN '), 'deploy:* & plan:*')
  })

  it('strips tsquery operators so a query cannot inject them', () => {
    // Without sanitisation these would parse as tsquery syntax rather than as
    // search terms, and a malformed expression makes Postgres raise.
    assert.equal(buildPrefixTsQuery('a & b'), 'a:* & b:*')
    assert.equal(buildPrefixTsQuery('a | b'), 'a:* & b:*')
    assert.equal(buildPrefixTsQuery('!a'), 'a:*')
    assert.equal(buildPrefixTsQuery('a <-> b'), 'a:* & b:*')
    assert.equal(buildPrefixTsQuery("(a):*'"), 'a:*')
  })

  it('returns null when nothing survives sanitisation', () => {
    assert.equal(buildPrefixTsQuery(''), null)
    assert.equal(buildPrefixTsQuery('   '), null)
    assert.equal(buildPrefixTsQuery('&|!()'), null)
  })

  it('keeps digits, which show up in ticket and error references', () => {
    assert.equal(buildPrefixTsQuery('issue 233'), 'issue:* & 233:*')
  })

  it('handles non-English input without dropping it entirely', () => {
    // Accented and non-Latin terms sanitize down rather than erroring; the
    // ASCII remainder still matches, and an all-non-Latin query yields null so
    // callers return no results instead of running an unbounded scan.
    assert.equal(buildPrefixTsQuery('café 12'), 'caf:* & 12:*')
    assert.equal(buildPrefixTsQuery('привет'), null)
  })
})
