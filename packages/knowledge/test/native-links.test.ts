import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@prisma/client'
import {
  extractWikilinks,
  replaceKnowledgePageLinks,
  resolveLinksToPage,
} from '../src/native-links.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const sourcePageId = '00000000-0000-4000-8000-000000000002'
const targetPageId = '00000000-0000-4000-8000-000000000003'
const otherTargetPageId = '00000000-0000-4000-8000-000000000004'
const spaceId = '00000000-0000-4000-8000-000000000005'

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

test('extractWikilinks parses a resolved anchor (data-kb-page-id, title = anchor text)', () => {
  const html = `<p>See <a data-kb-page-id="${targetPageId}">Runbook</a> for details.</p>`
  assert.deepEqual(extractWikilinks(html), [
    { targetPageId, targetTitle: 'Runbook' },
  ])
})

test('extractWikilinks parses an unresolved anchor (data-kb-unresolved-title, title = attribute value)', () => {
  const html = '<p>See <a data-kb-unresolved-title="Future Page">Future Page</a>.</p>'
  assert.deepEqual(extractWikilinks(html), [
    { targetPageId: null, targetTitle: 'Future Page' },
  ])
})

test('extractWikilinks strips nested inline tags from a resolved link title', () => {
  const html = `<a data-kb-page-id="${targetPageId}"><strong>Bold</strong> Title</a>`
  assert.deepEqual(extractWikilinks(html), [
    { targetPageId, targetTitle: 'Bold Title' },
  ])
})

test('extractWikilinks decodes &amp;/&lt;/&gt;/&quot;/&#39; in titles', () => {
  const html = '<a data-kb-unresolved-title="R&amp;D &lt;Notes&gt; &quot;Q3&quot; O&#39;Brien">x</a>'
  assert.deepEqual(extractWikilinks(html), [
    { targetPageId: null, targetTitle: `R&D <Notes> "Q3" O'Brien` },
  ])
})

test('extractWikilinks dedupes by (targetPageId ?? "", lowercased title)', () => {
  const html = `
    <a data-kb-page-id="${targetPageId}">Runbook</a>
    <a data-kb-page-id="${targetPageId}">RUNBOOK</a>
    <a data-kb-unresolved-title="Future Page">Future Page</a>
    <a data-kb-unresolved-title="future page">different anchor text</a>
  `
  assert.deepEqual(extractWikilinks(html), [
    { targetPageId, targetTitle: 'Runbook' },
    { targetPageId: null, targetTitle: 'Future Page' },
  ])
})

test('extractWikilinks ignores anchors with no wikilink data attribute', () => {
  const html = '<a href="https://example.com">External</a>'
  assert.deepEqual(extractWikilinks(html), [])
})

test('extractWikilinks returns [] for null or empty body', () => {
  assert.deepEqual(extractWikilinks(null), [])
  assert.deepEqual(extractWikilinks(''), [])
})

// ---------------------------------------------------------------------------
// replaceKnowledgePageLinks
// ---------------------------------------------------------------------------

type CapturedQuery = { sql: string; values: unknown[] }

const buildTx = (options: {
  findFirstSpaceId?: string | null
  resolvedRows?: Array<{ id: string }>
} = {}) => {
  const deleteCalls: unknown[] = []
  const createManyCalls: Array<Record<string, unknown>> = []
  const findFirstCalls: unknown[] = []
  const queryRawCalls: CapturedQuery[] = []
  const tx = {
    knowledgePageLink: {
      deleteMany: async (args: unknown) => {
        deleteCalls.push(args)
        return { count: 0 }
      },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        createManyCalls.push(...args.data)
        return { count: args.data.length }
      },
    },
    knowledgePage: {
      findFirst: async (args: unknown) => {
        findFirstCalls.push(args)
        return options.findFirstSpaceId ? { spaceId: options.findFirstSpaceId } : null
      },
    },
    $queryRaw: async (query: CapturedQuery) => {
      queryRawCalls.push(query)
      return options.resolvedRows ?? []
    },
  } as unknown as Prisma.TransactionClient
  return { tx, deleteCalls, createManyCalls, findFirstCalls, queryRawCalls }
}

test('replaceKnowledgePageLinks deletes existing links for the source page, then inserts the new set', async () => {
  const { tx, deleteCalls, createManyCalls } = buildTx()
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: `<a data-kb-page-id="${otherTargetPageId}">Other</a>`,
  })

  assert.deepEqual(deleteCalls, [{ where: { sourcePageId } }])
  assert.deepEqual(createManyCalls, [
    { organizationId, sourcePageId, targetPageId: otherTargetPageId, targetTitle: 'Other' },
  ])
})

test('replaceKnowledgePageLinks skips self-links (target === source)', async () => {
  const { tx, deleteCalls, createManyCalls } = buildTx()
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: `<a data-kb-page-id="${sourcePageId}">Self</a>`,
  })

  assert.equal(deleteCalls.length, 1)
  assert.deepEqual(createManyCalls, [])
})

test('replaceKnowledgePageLinks issues no resolution query when every link is already resolved', async () => {
  const { tx, queryRawCalls, findFirstCalls, createManyCalls } = buildTx()
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: `<a data-kb-page-id="${otherTargetPageId}">Other</a>`,
  })

  assert.equal(queryRawCalls.length, 0)
  assert.equal(findFirstCalls.length, 0)
  assert.equal(createManyCalls.length, 1)
})

test('replaceKnowledgePageLinks attempts resolution only for unresolved titles, and inserts the resolved id', async () => {
  const { tx, queryRawCalls, createManyCalls } = buildTx({ resolvedRows: [{ id: otherTargetPageId }] })
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: `
      <a data-kb-page-id="${targetPageId}">Already Linked</a>
      <a data-kb-unresolved-title="New Page">New Page</a>
    `,
  })

  assert.equal(queryRawCalls.length, 1)
  assert.deepEqual(createManyCalls, [
    { organizationId, sourcePageId, targetPageId, targetTitle: 'Already Linked' },
    { organizationId, sourcePageId, targetPageId: otherTargetPageId, targetTitle: 'New Page' },
  ])
})

test('replaceKnowledgePageLinks keeps an unresolved title null when no page matches', async () => {
  const { tx, createManyCalls } = buildTx({ resolvedRows: [] })
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: '<a data-kb-unresolved-title="Nowhere">Nowhere</a>',
  })

  assert.deepEqual(createManyCalls, [
    { organizationId, sourcePageId, targetPageId: null, targetTitle: 'Nowhere' },
  ])
})

test('replaceKnowledgePageLinks prefers a same-space match when resolving (ORDER BY space match)', async () => {
  const { tx, queryRawCalls } = buildTx({ findFirstSpaceId: spaceId, resolvedRows: [{ id: targetPageId }] })
  await replaceKnowledgePageLinks(tx, {
    organizationId,
    sourcePageId,
    bodyHtml: '<a data-kb-unresolved-title="New Page">New Page</a>',
  })

  const query = queryRawCalls[0]
  assert.ok(query)
  assert.match(query.sql, /ORDER BY\s*\(space_id = \?::uuid\) DESC,/)
  assert.ok(query.values.includes(spaceId))
})

test('replaceKnowledgePageLinks no-ops (after the delete) when the body has no wikilinks', async () => {
  const { tx, deleteCalls, createManyCalls, findFirstCalls } = buildTx()
  await replaceKnowledgePageLinks(tx, { organizationId, sourcePageId, bodyHtml: '<p>plain text</p>' })

  assert.equal(deleteCalls.length, 1)
  assert.equal(createManyCalls.length, 0)
  assert.equal(findFirstCalls.length, 0)
})

// ---------------------------------------------------------------------------
// resolveLinksToPage
// ---------------------------------------------------------------------------

test('resolveLinksToPage updates unresolved links matching the title exactly (case-insensitive)', async () => {
  const executeRawCalls: CapturedQuery[] = []
  const tx = {
    $executeRaw: async (query: CapturedQuery) => {
      executeRawCalls.push(query)
      return 1
    },
  } as unknown as Prisma.TransactionClient

  await resolveLinksToPage(tx, { organizationId, pageId: targetPageId, title: 'Runbook' })

  assert.equal(executeRawCalls.length, 1)
  const query = executeRawCalls[0]
  assert.ok(query)
  assert.match(query.sql, /SET target_page_id = /)
  assert.match(query.sql, /target_page_id IS NULL/)
  assert.match(query.sql, /lower\(target_title\) = lower\(/)
  assert.deepEqual(query.values, [targetPageId, organizationId, 'Runbook'])
})
