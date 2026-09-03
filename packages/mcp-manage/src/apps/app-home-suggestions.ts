import { APP_CATEGORIES, type AppCategory } from '@nessie/schemas'

/**
 * Editorial ordering for the App Store home shelves.
 *
 * A suggestion names the immutable registry identity of an app, not the
 * publisher-supplied display copy. It is deliberately source-controlled rather
 * than a catalogue column: the registry remains the catalogue authority.
 *
 * Selection is intentionally conservative: prefer the original product
 * publisher, then a clearly adopted community project. The list stops short of
 * a shelf's capacity where the registry cannot support that standard. During
 * registry import this explicit curator decision may lift a matching
 * `discovered` row to `curated`; it never changes the registry data, trust,
 * authentication, endpoint safety checks, or connection rules.
 */
export const APP_HOME_SUGGESTIONS: Record<AppCategory, readonly string[]> = {
  communication: [
    'com.microsoft/workiq-teamsserver',
    'io.github.zoom/zoom-team-chat',
    'io.github.zoom/zoom-meetings',
    'io.github.zoom/zoom-team',
    'com.green-api/whatsapp',
    'ai.izap/whatsapp',
    'com.uni-msg/whatsapp',
    'io.2chat/whatsapp',
    'ai.waystation/slack',
    'ai.waystation/gmail',
  ],
  development: [
    'io.github.github/github-mcp-server',
    'com.circleci/mcp',
    'com.gitlab/mcp',
    'io.github.PostHog/mcp',
    'com.statsig/statsig-mcp-server',
    'com.gameanalytics/analytics-docs',
    'com.senzing/mcp',
    'com.ezoic/setup',
    'com.searchcode/mcp',
    'com.smplkit/mcp',
    'com.roxyapi/docs',
  ],
  productivity: [
    'ai.chronary/mcp',
    'ai.naumu/mcp',
    'ai.smry.r/smry-product',
    'app.kanera/mcp',
    'com.cortexpad/cortexpad',
    'app.xtiles/xtiles-mcp',
    'app.recordo.api/recordo',
    'com.anotepad/notes',
    'io.github.Goran-Arsov/freshjots-mcp',
    'io.github.digital-wisdom-ai/wondercal',
  ],
  crm_sales: [
    'com.close/close-mcp',
    'com.salesql/salesql',
    'io.github.kunal-lead411/lead411',
    'ai.smithery/kesslerio-attio-mcp-server',
  ],
  project_management: [
    'app.linear/linear',
    'com.atlassian/atlassian-mcp-server',
    'app.easykanb/easykanban',
    'com.kanbanthing/kanban',
    'io.github.neoflintai/sprintflint',
    'io.github.Anymfah/stellary-project-management',
    'io.github.Sprintra-io/sprintra',
  ],
  customer_support: [
    'ai.chatthing/chat-thing',
    'chat.muro/support',
    'co.rulebase/rulebase',
    'com.alvrun/support',
  ],
  data_databases: [
    'com.supabase/mcp',
    'com.airtable/mcp',
    'com.keboola/mcp',
    'com.carto/carto',
    'co.axiom/mcp',
    'com.gibsonai/mcp',
    'co.thinair/data',
    'ai.mcpmyadmin/mcpmyadmin',
    'cloud.freebase/freebase',
  ],
  analytics: [
    'io.github.grafana/mcp-grafana',
    'com.amplitude/mcp-server',
    'com.newrelic/mcp-server',
    'com.bitmovin.mcp.analytics/analytics-mcp',
    'com.reportingninja/reporting-ninja',
    'com.hitsteps/analytics-operations',
    'com.chadanalytics/chad',
    'com.cookiefreeanalytics/mcp',
    'ai.mcpanalytics/analytics',
    'ai.analyticslegends/sap-analytics',
  ],
  finance: [
    'com.stripe/mcp',
    'com.paypal.mcp/mcp',
    'com.coinmarketcap/coinmarketcap',
    'com.avalara/avatax',
    'com.taxact/taxact-mcp',
    'io.etherscan/etherscan-mcp',
    'io.bitquery/mcp',
    'io.gainium/gainium-mcp',
    'io.wisesheets/wisesheets',
  ],
  marketing: [
    'ai.chinamarketing/intelligence',
    'io.afterlaunch/agentic-growth-marketing',
    'com.momenticmarketing/momentic',
    'ai.seocrawl/mcp',
    'ai.openhelm/seo-growth',
    'ai.trendsapi/seo',
    'ai.trendsmcp/seo',
    'ai.b77/seo-content-factory',
    'com.1stcollab/influencers',
    'ai.fodda/brand-intelligence',
  ],
  files_documents: [
    'com.microsoft/workiq-odspremoteserver',
    'com.microsoft/workiq-sharepointliststools',
    'do.craft.mcp/server',
    'io.carbone/carbone-mcp',
    'io.dadan/dadan',
    'app.superdocs/superdocs',
    'ai.pdfassistant/pdfassistant',
    'ai.file2markdown/file2markdown',
    'com.pastesheet/google-sheets',
    'io.clueso/video',
  ],
  ai_search: [
    'ai.exa/exa',
    'co.huggingface/hf-mcp-server',
    'ai.parallel/search-mcp',
    'ai.parallel/task-mcp',
    'com.andiai/andi-search',
    'ai.fodda/deep-research',
    'ai.fodda/topic-research',
    'ai.livingmeta/ai-in-research',
  ],
  infrastructure: [
    'com.cloudflare.mcp/mcp',
    'com.googleapis.run/mcp',
    'com.googleapis.container/mcp',
    'com.ovhcloud.eu.mcp/api',
    'com.railway/mcp',
    'com.vercel/vercel-mcp',
    'com.qovery/mcp-server',
    'io.cpln/control-plane',
    'com.googleapis.firestore/mcp',
    'com.googleapis.datastream/mcp',
  ],
  commerce: [
    'io.github.checkout/mcp',
    'com.sprintcheckout/sprintcheckout',
    'com.checkoutpage/checkout-page',
    'io.github.tourmind-com/hotel-booking-ai-mcp',
  ],
  other: [
    'com.figma.mcp/mcp',
    'com.googleapis.mapstools/mcp',
    'com.wolfram/mcp',
    'com.mindmeister/mcp',
    'com.whimsical/mcp',
    'io.github.AnimaApp/anima',
    'com.googleapis.developerknowledge/mcp',
    'com.googleapis.design/mcp',
    'com.googleapis.stitch/mcp',
    'com.googleapis.androidmanagement/mcp',
  ],
}

type HomeSuggestionRow = {
  id: string
  primaryCategory: AppCategory
  registryName: string | null
}

/** A single query covers the (small) editorial candidate set across all shelves. */
const APP_HOME_SUGGESTION_REGISTRY_NAME_SET = new Set(
  APP_CATEGORIES.flatMap((category) => APP_HOME_SUGGESTIONS[category]),
)

export const appHomeSuggestionRegistryNames = (): string[] => [
  ...APP_HOME_SUGGESTION_REGISTRY_NAME_SET,
]

/** Whether a registry record has an explicit source-controlled curator decision. */
export const isAppHomeSuggestionRegistryName = (registryName: string): boolean =>
  APP_HOME_SUGGESTION_REGISTRY_NAME_SET.has(registryName)

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
