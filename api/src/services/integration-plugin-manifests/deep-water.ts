import type { IntegrationPluginManifest } from '@nessie/schemas'

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
  version: '0.2.1',
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
    tools: [
      {
        name: 'research_start',
        label: 'Start research',
        description: 'Start a Ledger-owned, raw-usage-metered Deep Water research job.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 3,
              maxLength: 20_000,
              description: 'Research question or task.',
            },
            context: {
              type: 'string',
              maxLength: 50_000,
              description: 'Optional constraints and background for the research.',
            },
            depth: {
              type: 'string',
              enum: ['light', 'standard', 'deep', 'heavy'],
              default: 'standard',
            },
            recency: {
              type: 'string',
              enum: ['any', 'recent'],
              default: 'any',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_status',
        label: 'Read research status',
        description: 'Read progress and terminal state for a Ledger-owned research job.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Ledger research job id.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_report',
        label: 'Read research report',
        description: 'Read the completed report and references for a Ledger-owned research job.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Ledger research job id.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_list',
        label: 'List research',
        description: 'List research jobs owned by the delegated UOA user through Ledger.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
            },
          },
          additionalProperties: false,
        },
        privacyTier: 'normal',
        status: 'available',
      },
      {
        name: 'research_cancel',
        label: 'Cancel research',
        description: 'Cancel a running Ledger-owned research job.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Ledger research job id.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        privacyTier: 'sensitive',
        status: 'available',
      },
    ],
  },
  ui: {
    pages: [
      { id: 'research-launcher', label: 'Research launcher', status: 'available' },
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
      // Ledger-backed connector is active for the workspace.
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
