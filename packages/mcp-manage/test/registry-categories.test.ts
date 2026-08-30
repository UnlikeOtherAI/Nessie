import assert from 'node:assert/strict'
import test from 'node:test'

import { CATEGORY_RULES, classifyRegistryApp } from '../src/index.js'

/**
 * The classification rules. Deterministic string matching is correct here and
 * is *not* the "intent is model-judged" rule's territory: this reads a
 * machine-authored catalogue record written to a published schema, not a
 * person's message.
 */

const classify = (
  name: string,
  description: string,
  title: string | null = null,
): ReturnType<typeof classifyRegistryApp> =>
  classifyRegistryApp({ name, title, description })

test('the taxonomy the rules name is the taxonomy the store has', () => {
  // A rule for a category the enum does not carry would silently never match.
  const categories = new Set(CATEGORY_RULES.map((rule) => rule.category))
  assert.equal(categories.size, CATEGORY_RULES.length, 'one rule per category')
})

test('vendors land on the shelf a person would put them on', () => {
  const cases: Array<[string, string, string]> = [
    ['io.github.acme/github-mcp', 'Repositories, issues and pull requests.', 'development'],
    ['io.github.acme/gitlab-mcp', 'Work with GitLab repositories.', 'development'],
    ['app.linear/mcp', 'Create and update issues and projects in Linear.', 'project_management'],
    ['com.atlassian/jira', 'Jira issues, sprints and boards.', 'project_management'],
    ['com.google/gmail-mcp', 'Read and send email from Gmail.', 'communication'],
    ['com.microsoft/outlook', 'Outlook mail and calendar access.', 'communication'],
    ['com.hubspot/mcp', 'HubSpot contacts, companies and deals.', 'crm_sales'],
    ['com.salesforce/mcp', 'Query and update Salesforce records.', 'crm_sales'],
    ['org.postgresql/mcp', 'Run read-only SQL against a Postgres database.', 'data_databases'],
    ['com.mongodb/mcp', 'Query MongoDB collections.', 'data_databases'],
    ['com.stripe/mcp', 'Payments, customers and invoices.', 'finance'],
    ['com.zendesk/mcp', 'Zendesk support tickets and users.', 'customer_support'],
    ['com.shopify/mcp', 'Shopify storefront orders and products.', 'commerce'],
    ['com.mailchimp/mcp', 'Mailchimp campaigns and audiences.', 'marketing'],
    ['com.datadoghq/mcp', 'Datadog metrics, monitors and dashboards.', 'analytics'],
    ['com.cloudflare/mcp', 'Cloudflare DNS, Workers and deployments.', 'infrastructure'],
    ['com.dropbox/mcp', 'Dropbox file storage and sharing.', 'files_documents'],
    ['com.firecrawl/mcp', 'Scrape and crawl any website into markdown.', 'ai_search'],
    ['so.notion/mcp', 'Search and update pages in your Notion workspace.', 'productivity'],
  ]
  for (const [name, description, expected] of cases) {
    assert.equal(classify(name, description).primaryCategory, expected, name)
  }
})

test('ordering settles the overlaps, so GitHub is development and Linear is not', () => {
  // Both descriptions say "issues". `development` is consulted first and only
  // GitHub's copy matches it, which is exactly what the table order is for.
  assert.equal(
    classify('io.github.acme/github-mcp', 'GitHub issues and pull requests.').primaryCategory,
    'development',
  )
  assert.equal(
    classify('app.linear/mcp', 'Track issues and sprints.').primaryCategory,
    'project_management',
  )
})

test('a keyword matches a whole token or a whole phrase, never a prefix', () => {
  // `mail` must not reach `mailchimp`, or a marketing tool silently becomes a
  // mail client.
  assert.equal(
    classify('com.mailchimp/mcp', 'Mailchimp campaigns.').primaryCategory,
    'marketing',
  )
  // A phrase keyword still matches across the space.
  assert.equal(
    classify('io.example/thing', 'Read and write to a data warehouse.').primaryCategory,
    'data_databases',
  )
})

test('nothing recognisable stays in other rather than guessing a shelf', () => {
  const classification = classify('io.example/widget-mcp', 'A useful thing.')
  assert.equal(classification.primaryCategory, 'other')
  assert.deepEqual(classification.categories, ['other'])
  assert.deepEqual(classification.tags, [])
})

test('tags are the words the record actually used', () => {
  const classification = classify(
    'org.postgresql/mcp',
    'Run SQL against a Postgres database.',
  )
  assert.ok(classification.tags.includes('postgres'))
  assert.ok(classification.tags.includes('database'))
  assert.ok(classification.tags.includes('sql'))
  // Not claimed by this record, so not claimed on its behalf.
  assert.equal(classification.tags.includes('snowflake'), false)
})

test('aliases are what a person types, plus the name its publisher chose', () => {
  const classification = classify(
    'io.github.acme/notion-mcp',
    'Search and update pages in your Notion workspace.',
  )
  assert.ok(classification.aliases.includes('notes'), 'rule synonym')
  assert.ok(classification.aliases.includes('notion'), 'name-derived')
  // "mcp" and "server" describe the protocol, not the product.
  assert.equal(classification.aliases.includes('mcp'), false)
})

test('an app on two genuine shelves is a member of both, primary first', () => {
  const classification = classify(
    'io.example/supabase-mcp',
    'Query a Postgres database and deploy edge functions on Vercel.',
  )
  assert.equal(classification.categories[0], classification.primaryCategory)
  assert.ok(classification.categories.length > 1)
  assert.ok(classification.categories.length <= 3, 'membership stays bounded')
})

test('an empty description still classifies from the name it was published under', () => {
  const classification = classify('io.github.acme/postgres-mcp', '')
  assert.equal(classification.primaryCategory, 'data_databases')
  assert.ok(classification.aliases.includes('postgres'))
})

test('the expanded rules pull representative real descriptions off the Other shelf', () => {
  // Each of these is a shape that measured as `other` before the table grew.
  const cases: Array<[string, string, string]> = [
    // Crypto is one of the biggest buckets, so the asset words its servers use
    // resolve to finance even with no vendor name in sight.
    [
      'io.github.acme/coingecko-mcp',
      'Real-time cryptocurrency prices, market data and market cap for Bitcoin and Ethereum.',
      'finance',
    ],
    ['io.example/nft-tracker', 'Track NFT floor prices and on-chain wallet activity.', 'finance'],
    // Media handling lives on the Files & Documents shelf.
    [
      'io.github.acme/whisper-mcp',
      'Transcription of YouTube videos and audio into text, subtitles and screenshots.',
      'files_documents',
    ],
    // B2B prospecting is CRM & Sales, the first rule in the table.
    ['io.github.acme/leadgen-mcp', 'Find B2B leads and enrich company data for sales prospecting.', 'crm_sales'],
  ]
  for (const [name, description, expected] of cases) {
    assert.equal(classify(name, description).primaryCategory, expected, name)
  }
})

test('ordering keeps a repo tool in development even when it mentions money words', () => {
  // `finance` sits above `development` in the table, so an incidental finance or
  // market word in a repo description would out-rank `github` — unless the word
  // is one finance deliberately does not claim. The ambiguous singulars
  // 'market', 'price' and 'pricing' are left out for exactly this reason, so the
  // GitHub tool stays where it belongs.
  const classification = classify(
    'io.github.acme/github-mcp',
    'Manage GitHub repositories, issues and pull requests. Tracks the market price and pricing of CI runs.',
  )
  assert.equal(classification.primaryCategory, 'development')
})

test('the ambiguous singulars price / pricing / market never alone mean finance', () => {
  // The counterpart to the rule above: a server whose only money-adjacent words
  // are the omitted singulars matches no finance keyword and stays in `other`,
  // rather than being mis-shelved. A wrong shelf is worse than Other.
  const classification = classify(
    'io.example/thing',
    'Track the price and the market, and publish your product pricing.',
  )
  assert.notEqual(classification.primaryCategory, 'finance')
  assert.equal(classification.primaryCategory, 'other')
})

test('a re-shelved app carries the words it actually used as tags', () => {
  // Tags feed the search index, and are the words present in the record — never
  // the rule's whole vocabulary.
  const classification = classify(
    'io.github.acme/coingecko-mcp',
    'Real-time cryptocurrency prices and market data for Bitcoin.',
  )
  assert.ok(classification.tags.includes('cryptocurrency'))
  assert.ok(classification.tags.includes('bitcoin'))
  assert.equal(classification.tags.includes('ethereum'), false)
})
