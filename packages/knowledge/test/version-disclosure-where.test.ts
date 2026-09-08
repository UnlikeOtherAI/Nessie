import assert from 'node:assert/strict'
import test from 'node:test'
import { readableKnowledgePageVersionsWhere } from '../src/version-disclosure-where.js'

test('query-time version gate withholds any page carrying an unreadable historical version', () => {
  assert.deepEqual(readableKnowledgePageVersionsWhere({
    kind: 'user',
    scopes: [{ scopeId: 'channel-a', scopeType: 'channel' }],
    userId: 'user-a',
  }), {
    versions: {
      none: {
        OR: [
          { disclosureSources: { some: { sourceAuthorUserId: null } } },
          {
            basisScopes: {
              some: {
                NOT: { OR: [{ scopeId: 'channel-a', scopeType: 'channel' }] },
              },
            },
          },
        ],
      },
    },
  })
})

test('an autonomous reader receives only versions with no retained basis or unknown author', () => {
  assert.deepEqual(readableKnowledgePageVersionsWhere({ kind: 'autonomous' }), {
    versions: {
      none: {
        OR: [
          { basisScopes: { some: {} } },
          { disclosureSources: { some: { sourceAuthorUserId: null } } },
        ],
      },
    },
  })
})


test('a denied viewer receives an impossible page predicate, including unrestricted versions', () => {
  assert.deepEqual(readableKnowledgePageVersionsWhere({ kind: 'denied' }), {
    id: { in: [] },
  })
})
