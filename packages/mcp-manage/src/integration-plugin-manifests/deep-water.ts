import type { IntegrationPluginManifest } from '@nessie/schemas'

import { DEEP_WATER_BRIEF_CONTRACT_VERSION, deepWaterBriefTools } from './deep-water-brief-tools.js'

/**
 * DeepWater's first-party product contract is isolated because Ledger routing,
 * schemas, credential ownership, and raw-metering semantics form one cohesive boundary
 * that evolves independently from the other sibling products.
 */
export const deepWaterIntegrationPluginManifest = {
  apiVersion: 'integrations.nessie.io/v1',
  kind: 'NessieIntegrationPlugin',
  manifestRef: 'first-party/deep-water',
  productSlug: 'deep-water',
  name: 'Deep Water',
  version: DEEP_WATER_BRIEF_CONTRACT_VERSION,
  vendor: 'UnlikeOtherAI',
  install: [
    {
      mode: 'hosted_preinstall',
      availability: 'hosted',
      label: 'Ledger-metered research',
      requiredForAgentUse: true,
      setup:
        'Bind the Ledger adapter with Nessie\'s dedicated Ledger app API key; '
        + 'signed SSO identity is delegated independently on every call. '
        + 'Keep webhook signing secrets separate.',
    },
  ],
  mcp: {
    catalogTemplate: {
      name: 'deep-water',
      label: 'Deep Water',
      protocol: 'http',
      authMethod: 'bearer',
      transport: {
        transport: 'http',
        urlEnv: 'LEDGER_DEEPWATER_MCP_URL',
      },
      auth: { method: 'bearer' },
    },
    toolBundleRef: 'first-party/deep-water-tools',
    // The brief-first contract (Water plan contract D8, §5.2, manifest 0.3.0):
    // every research Nessie starts is agreed with DeepWater's planner first,
    // so `research_start` is not projected. The input schemas equal Ledger's
    // `tools/list` exactly (deep-water.ledger-contract.json); a team on the
    // launcher contract is upgraded in place on its owner's next enable
    // (`projectDeepWaterTeamContract`, amendments N9.1).
    tools: deepWaterBriefTools,
  },
  ui: {
    pages: [
      { id: 'research-brief', label: 'Research brief', status: 'available' },
      { id: 'research-runs', label: 'Research runs', status: 'planned' },
      { id: 'research-sources', label: 'Sources and evidence', status: 'planned' },
    ],
    cards: [
      { kind: 'deep_research', label: 'Research progress/result', status: 'available' },
      { kind: 'integration', label: 'Usage and setup status', status: 'available' },
    ],
    controls: [
      { id: 'research-depth', label: 'Depth', status: 'available' },
      { id: 'research-search-quality', label: 'Search quality', status: 'available' },
      { id: 'artifact-destination', label: 'Knowledge destination', status: 'available' },
      { id: 'budget-cap', label: 'Budget cap', status: 'planned' },
    ],
  },
  surfaces: [
    {
      type: 'documents_section',
      id: 'research',
      label: 'Research',
      view: 'deep-water-research',
      // The native history/launcher is reachable only while the generated
      // Ledger-backed connector is active for the team.
      requires: { connectorActive: true },
    },
  ],
  artifacts: [
    {
      kind: 'knowledge_page',
      label: 'Research report',
      defaultDestination: 'Knowledge',
      fileServiceRequired: false,
    },
    {
      kind: 'source_bundle',
      label: 'Source and evidence bundle',
      defaultDestination: 'Knowledge attachments',
      fileServiceRequired: true,
    },
  ],
  privacy: {
    dataBoundary: 'Research prompts, sources, and reports may enter Nessie after user or agent launch.',
    defaultImportPolicy: 'Import completed reports and source metadata into Knowledge only after the run completes.',
    prohibitedByDefault: ['raw credential values', 'unapproved private source dumps'],
  },
  usage: {
    ledger: 'connector_usage_events',
    connectorType: 'mcp',
    // Nessie's row is operational call/source telemetry only. Ledger sends raw
    // usage to UOA, which is the sole commercial authority.
    costFields: [],
  },
} satisfies IntegrationPluginManifest
