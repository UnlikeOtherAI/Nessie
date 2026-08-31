import { APP_CATEGORIES, type AppCategory } from '@nessie/schemas'

/**
 * Editorial ordering for the App Store home shelves.
 *
 * A suggestion names the immutable registry identity of an app, not the
 * publisher-supplied display copy. It is deliberately source-controlled rather
 * than a catalogue column: the registry remains the catalogue authority and a
 * suggestion cannot affect visibility, moderation, trust, or a connection.
 *
 * Entries are only promoted when they are already present in the caller's
 * visible result set. A stale, removed, reclassified, or hidden registry entry
 * therefore disappears naturally instead of creating a broken card.
 */
export const APP_HOME_SUGGESTIONS: Record<AppCategory, readonly string[]> = {
  communication: [
    'com.microsoft/workiq-teamsserver',
    'io.github.zoom/zoom-team-chat',
    'ai.waystation/slack',
    'ai.waystation/gmail',
  ],
  development: [
    'io.github.github/github-mcp-server',
    'app.linear/linear',
    'com.stripe/mcp',
  ],
  productivity: [
    'com.notion/mcp',
    'net.todoist/mcp',
    'com.atlassian/atlassian-mcp-server',
  ],
  crm_sales: [
    'com.close/close-mcp',
    'ai.cirra/salesforce-mcp',
    'io.github.pipeworx-io/pipedrive',
    'io.github.pipeworx-io/zoho_crm',
  ],
  project_management: [
    'app.linear/linear',
    'com.notion/mcp',
    'com.monday/monday.com',
    'net.todoist/mcp',
  ],
  customer_support: [
    'io.github.pipeworx-io/intercom',
    'io.github.pipeworx-io/zendesk',
    'io.github.pipeworx-io/hubspot',
    'io.github.pipeworx-io/freshdesk',
  ],
  data_databases: ['com.supabase/mcp', 'com.airtable/mcp', 'io.github.mcp-dir/neon-mcp'],
  analytics: [
    'com.amplitude/mcp-server',
    'io.github.PostHog/mcp',
    'io.usefulapi/mixpanel',
  ],
  finance: [
    'com.stripe/mcp',
    'com.caribooks/quickbooks',
    'com.getboxkite/xero-backup-export',
  ],
  marketing: [
    'ai.adplane/google-ads',
    'ai.adweave/meta-ads-mcp',
    'ai.com.mcp/linkedin',
    'io.github.Centrify-Internal/hubspot-integrations-mcp',
  ],
  files_documents: [
    'com.microsoft/workiq-sharepointliststools',
    'io.github.pipeworx-io/onedrive',
    'io.github.pipeworx-io/dropbox',
  ],
  ai_search: ['ai.exa/exa', 'io.github.upstash/context7', 'io.searchapi/mcp'],
  infrastructure: [
    'com.cloudflare.mcp/mcp',
    'com.vercel/vercel-mcp',
    'com.newrelic/mcp-server',
    'io.github.grafana/mcp-grafana',
  ],
  commerce: [
    'ai.gossiper/shopify-admin-mcp',
    'com.datadoe/amazon-seller-mcp',
    'co.curie/commerce',
  ],
  other: ['com.figma.mcp/mcp', 'io.github.miroapp/mcp-server', 'com.zapier/mcp'],
}

type HomeSuggestionRow = {
  id: string
  primaryCategory: AppCategory
  registryName: string | null
}

/** A single query covers the (small) editorial candidate set across all shelves. */
export const appHomeSuggestionRegistryNames = (): string[] => [
  ...new Set(APP_CATEGORIES.flatMap((category) => APP_HOME_SUGGESTIONS[category])),
]

/**
 * Preserves the stable shelf order after inserting the valid suggestions ahead
 * of it. An app cannot move into a shelf the catalogue does not assign it to.
 */
export const prioritizeHomeShelf = <T extends HomeSuggestionRow>(
  category: AppCategory,
  suggestions: readonly T[],
  shelf: readonly T[],
  limit: number,
): T[] => {
  const candidatesByRegistryName = new Map(
    suggestions
      .filter((row) => row.primaryCategory === category && row.registryName !== null)
      .map((row) => [row.registryName!, row]),
  )
  const selected = APP_HOME_SUGGESTIONS[category].flatMap((registryName) => {
    const row = candidatesByRegistryName.get(registryName)
    return row ? [row] : []
  })
  const seen = new Set(selected.map((row) => row.id))
  return [...selected, ...shelf.filter((row) => !seen.has(row.id))].slice(0, limit)
}
