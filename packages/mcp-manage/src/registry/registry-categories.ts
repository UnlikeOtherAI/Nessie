import type { AppCategory } from '@nessie/schemas'

/**
 * Which shelf an ingested registry server lands on, and the words that will
 * find it.
 *
 * Deterministic string rules are the right tool here and do not conflict with
 * AGENTS.md's "intent is model-judged, never string-matched". That rule governs
 * reading what a *person* meant — natural language, any tongue, slang,
 * misspellings. This classifies a machine-authored catalogue record written to
 * a published schema, in English, by a publisher who chose the words on
 * purpose. Sending thousands of records through a model would cost real money
 * to produce an answer nobody could reproduce or correct.
 *
 * One table, ordered, first match wins. Ordering is the whole design: GitHub's
 * description says "issues" and Linear's says "issues", so `development`
 * (matched by the token `github`) must be consulted before
 * `project_management` (matched by `issues`). Read the table top to bottom and
 * the classification of any record is obvious by inspection — which is the
 * property that lets a curator disagree with it precisely.
 *
 * Only the *last path segment* of the registry name is read. `io.github.acme`
 * is a namespace claim — every publisher who registered through GitHub carries
 * it — so counting it as evidence filed `io.github.acme/postgres-mcp` under
 * Development.
 *
 * A rule that matches nothing leaves the app in `other`. That is not a failure:
 * an uncategorised app is still searchable by name, and a wrong shelf is worse
 * than no shelf.
 */

type CategoryRule = {
  category: AppCategory
  /**
   * Single words match a whole token; anything containing a space matches as a
   * phrase. Both are exact — no prefixes, because `mail` prefix-matching
   * `mailchimp` silently moves a marketing tool into Communication and nothing
   * in the table says so.
   */
  keywords: readonly string[]
  /** Search synonyms this rule contributes — the words a person actually types. */
  aliases: readonly string[]
}

export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'crm_sales',
    keywords: [
      'hubspot', 'salesforce', 'pipedrive', 'zoho', 'attio', 'copper', 'crm',
      'sales pipeline', 'lead management', 'leads', 'prospects', 'salesloft', 'outreach',
      'b2b', 'lead generation', 'prospecting', 'contact enrichment', 'company data',
      'sales intelligence', 'customer records',
    ],
    aliases: ['crm', 'sales', 'leads', 'contacts', 'pipeline', 'deals'],
  },
  {
    category: 'customer_support',
    keywords: [
      'zendesk', 'intercom', 'freshdesk', 'helpscout', 'helpdesk', 'help desk',
      'customer support', 'support tickets', 'live chat', 'crisp',
    ],
    aliases: ['support', 'helpdesk', 'tickets', 'customers', 'service desk'],
  },
  {
    category: 'commerce',
    keywords: [
      'shopify', 'woocommerce', 'magento', 'bigcommerce', 'ecommerce', 'e-commerce',
      'storefront', 'shopping cart', 'checkout', 'etsy', 'squarespace', 'product catalog',
      'orders', 'marketplace', 'shipping', 'inventory', 'retail', 'merchant',
      'booking', 'bookings', 'reservations', 'travel', 'flights', 'hotels',
    ],
    aliases: ['shop', 'store', 'ecommerce', 'orders', 'products', 'checkout'],
  },
  {
    category: 'finance',
    // Crypto is one of the largest live buckets in the registry, so the
    // chain/asset words real descriptions use ('bitcoin', 'ethereum', 'nft',
    // 'market cap') are spelled out rather than left to 'crypto' alone.
    // Deliberately absent: the bare tokens 'price', 'pricing' and 'market'.
    // Finance is consulted before `development`, so any of them would file a
    // repo tool that mentions "CI pricing" or "go to market" under Finance —
    // exactly the mis-shelf the table order exists to prevent. The plural,
    // finance-specific forms ('prices', 'markets', 'market data', 'market cap')
    // carry the signal without the collision.
    keywords: [
      'stripe', 'quickbooks', 'xero', 'paypal', 'plaid', 'freshbooks', 'brex', 'ramp',
      'invoice', 'invoices', 'invoicing', 'billing', 'accounting', 'payments', 'payroll',
      'bookkeeping', 'expenses', 'banking', 'trading', 'portfolio', 'sec filings',
      'markets', 'market data', 'market cap', 'stock', 'stocks', 'equities', 'crypto',
      'cryptocurrency', 'crypto token', 'blockchain', 'on-chain', 'onchain', 'defi',
      'staking', 'bitcoin', 'ethereum', 'solana', 'nft', 'wallet', 'usdc',
      'exchange rates', 'currency', 'ticker', 'earnings', 'financial data',
      'prices', 'price history', 'tax', 'treasury', 'futures', 'iban',
    ],
    // Kept to two additions: `aliases` shares the MAX_ALIASES budget with the
    // app's own name tokens (`nameAliases`), which are what find a
    // description-less app by its published name.
    aliases: ['payments', 'invoices', 'billing', 'accounting', 'finance', 'money', 'crypto', 'trading'],
  },
  {
    category: 'marketing',
    keywords: [
      'mailchimp', 'klaviyo', 'sendgrid', 'mailerlite', 'brevo', 'buffer', 'hootsuite',
      'ahrefs', 'semrush', 'seo', 'newsletter', 'campaigns', 'google ads', 'adwords',
      'marketing automation',
      'brand', 'branding', 'social media', 'advertising', 'content marketing',
      'influencer', 'copywriting', 'ad campaigns',
    ],
    aliases: ['marketing', 'campaigns', 'seo', 'ads', 'newsletter', 'audience'],
  },
  {
    category: 'development',
    keywords: [
      'github', 'gitlab', 'bitbucket', 'git', 'repository', 'repositories', 'repo',
      'pull request', 'pull requests', 'source code', 'codebase', 'code review', 'sentry',
      'circleci', 'jenkins', 'sonarqube', 'npm', 'pypi', 'linter', 'debugger', 'compiler',
      'unit tests', 'continuous integration', 'sdk', 'sdks', 'feature flags',
    ],
    aliases: ['code', 'git', 'repo', 'developer', 'programming', 'commits', 'pull requests'],
  },
  {
    category: 'project_management',
    keywords: [
      'linear', 'jira', 'asana', 'trello', 'clickup', 'basecamp', 'shortcut',
      'youtrack', 'wrike', 'smartsheet', 'issue', 'issues', 'sprint', 'sprints',
      'kanban', 'backlog', 'roadmap', 'epics', 'project management', 'task tracking',
    ],
    aliases: ['issues', 'tickets', 'tasks', 'projects', 'sprints', 'roadmap', 'backlog'],
  },
  {
    category: 'communication',
    keywords: [
      'slack', 'gmail', 'outlook', 'discord', 'telegram', 'whatsapp', 'twilio', 'matrix',
      'zoom', 'mattermost', 'microsoft teams', 'email', 'mail', 'mailbox', 'inbox',
      'imap', 'smtp', 'sms', 'messaging', 'chat messages', 'video calls',
    ],
    aliases: ['email', 'mail', 'chat', 'messages', 'inbox', 'messaging'],
  },
  {
    category: 'data_databases',
    keywords: [
      'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongo', 'sqlite', 'redis',
      'clickhouse', 'snowflake', 'bigquery', 'duckdb', 'cassandra', 'elasticsearch',
      'opensearch', 'supabase', 'planetscale', 'airtable', 'database', 'databases', 'sql',
      'data warehouse',
      'dataset', 'datasets', 'public data', 'open data', 'records lookup',
    ],
    aliases: ['database', 'sql', 'query', 'data', 'tables', 'warehouse'],
  },
  {
    category: 'analytics',
    keywords: [
      'analytics', 'metrics', 'grafana', 'prometheus', 'datadog', 'mixpanel', 'amplitude',
      'posthog', 'tableau', 'looker', 'telemetry', 'observability', 'dashboards',
      'business intelligence',
      'signals', 'trends', 'benchmarks', 'kpi',
    ],
    aliases: ['analytics', 'metrics', 'reporting', 'dashboards', 'insights'],
  },
  {
    category: 'infrastructure',
    keywords: [
      'aws', 'azure', 'gcp', 'google cloud', 'cloudflare', 'kubernetes', 'k8s',
      'terraform', 'docker', 'ansible', 'pulumi', 'vercel', 'netlify', 'heroku',
      'digitalocean', 'devops', 'deployment', 'deployments', 'provisioning', 'nginx',
      'cloud infrastructure',
      'monitoring', 'uptime', 'dns', 'ssl', 'hosting', 'status page', 'alerting',
    ],
    aliases: ['cloud', 'devops', 'infrastructure', 'deploy', 'servers', 'hosting'],
  },
  {
    category: 'files_documents',
    keywords: [
      'google drive', 'dropbox', 'onedrive', 'sharepoint', 'google sheets', 'google docs',
      'spreadsheet', 'spreadsheets', 'pdf', 'pdfs', 'docx', 'file storage', 'filesystem',
      'documents',
      'video', 'videos', 'image', 'images', 'audio', 'photo', 'photos',
      'transcript', 'transcripts', 'transcription', 'youtube', 'ocr',
      'screenshot', 'screenshots', 'subtitles',
    ],
    aliases: ['files', 'documents', 'storage', 'drive', 'pdf', 'spreadsheets', 'video', 'transcription'],
  },
  {
    category: 'ai_search',
    keywords: [
      'openai', 'anthropic', 'huggingface', 'hugging face', 'perplexity', 'firecrawl',
      'tavily', 'serper', 'exa', 'web search', 'search the web', 'scraping', 'scrape',
      'crawler', 'crawl', 'embeddings', 'vector search', 'rag', 'llm', 'language model',
      'research', 'deep research', 'intelligence', 'memory', 'agent memory',
      'knowledge base', 'semantic search', 'inference', 'prompts',
      'summarization', 'evaluation',
    ],
    aliases: ['search', 'ai', 'llm', 'research', 'scraping', 'web', 'memory', 'embeddings'],
  },
  {
    category: 'productivity',
    keywords: [
      'notion', 'obsidian', 'evernote', 'todoist', 'readwise', 'raindrop', 'toggl',
      'clockify', 'calendar', 'calendars', 'notes', 'note-taking', 'reminders',
      'bookmarks', 'time tracking',
    ],
    aliases: ['notes', 'calendar', 'todo', 'reminders', 'productivity'],
  },
]

/** Words in a registry name that describe the protocol, not the product. */
const NAME_NOISE = new Set(['mcp', 'server', 'servers', 'api', 'io', 'com', 'org', 'net'])

const MAX_TAGS = 8
const MAX_ALIASES = 10
const MAX_CATEGORIES = 3

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9+]+/).filter((token) => token.length > 0)

export type ClassifiableRecord = {
  name: string
  title: string | null
  description: string
}

export type AppClassification = {
  primaryCategory: AppCategory
  /** Primary first, then any other shelf the same record genuinely belongs on. */
  categories: AppCategory[]
  tags: string[]
  aliases: string[]
}

/** `io.github.acme/notion-mcp` → `notion-mcp`; the product half of the name. */
const productSegment = (name: string): string => name.split('/').pop() ?? name

/**
 * The product words in `io.github.acme/notion-mcp` → `["notion"]`. Carried as
 * aliases so a server whose description is empty — and plenty are — is still
 * findable by the name its publisher gave it.
 */
const nameAliases = (name: string): string[] =>
  tokenize(productSegment(name)).filter(
    (token) => !NAME_NOISE.has(token) && token.length > 2,
  )

const matchedKeywords = (
  rule: CategoryRule,
  text: string,
  tokens: ReadonlySet<string>,
): string[] =>
  rule.keywords.filter((keyword) =>
    keyword.includes(' ') || keyword.includes('-')
      ? text.includes(keyword)
      : tokens.has(keyword),
  )

const dedupe = <T>(values: readonly T[], limit: number): T[] =>
  [...new Set(values)].slice(0, limit)

export const classifyRegistryApp = (record: ClassifiableRecord): AppClassification => {
  const text = [productSegment(record.name), record.title ?? '', record.description]
    .join(' ')
    .toLowerCase()
  const tokens = new Set(tokenize(text))

  const hits = CATEGORY_RULES
    .map((rule) => ({ rule, keywords: matchedKeywords(rule, text, tokens) }))
    .filter((hit) => hit.keywords.length > 0)

  const primary = hits[0]
  const fromName = nameAliases(record.name)
  if (!primary) {
    return {
      primaryCategory: 'other',
      categories: ['other'],
      tags: [],
      aliases: dedupe(fromName, MAX_ALIASES),
    }
  }

  return {
    primaryCategory: primary.rule.category,
    categories: dedupe(hits.map((hit) => hit.rule.category), MAX_CATEGORIES),
    // The words actually present in the record, not the rule's whole vocabulary:
    // a tag that is not in the app's own copy is a claim nobody made.
    tags: dedupe(hits.flatMap((hit) => hit.keywords), MAX_TAGS),
    aliases: dedupe([...primary.rule.aliases, ...fromName], MAX_ALIASES),
  }
}
