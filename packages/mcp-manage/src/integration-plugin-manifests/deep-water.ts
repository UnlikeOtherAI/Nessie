import type { IntegrationPluginManifest } from '@nessie/schemas'

import { deepWaterToolInputSchemas } from './deep-water-tool-schemas.js'

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
  version: '0.3.0',
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
    // The brief-first contract (Water plan contract D8, §5.2): every research
    // Nessie starts is agreed with DeepWater's planner first, so
    // `research_start` is not projected. Input schemas equal Ledger's
    // `tools/list` exactly (deep-water.ledger-contract.json).
    tools: [
      {
        name: 'research_scope_start',
        label: 'Open a research brief',
        description:
          'Open a DeepWater research brief for a question. DeepWater\'s research planner proposes '
          + 'pillars (each becomes a chapter) and settings. Put background and constraints in '
          + 'context as plain prose. Returns at once; the planner answers later and you are woken '
          + 'in this thread when it does, so do not poll. Every research starts with a brief.',
        inputSchema: deepWaterToolInputSchemas.research_scope_start,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_scope_reply',
        label: 'Reply to the research planner',
        description:
          'Answer DeepWater\'s research planner on an open brief. To edit, send base_revision with '
          + 'the replacement pillars list and only the settings you change (null clears one). '
          + 'Returns at once; you are woken when the planner answers.',
        inputSchema: deepWaterToolInputSchemas.research_scope_reply,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_scope_get',
        label: 'Read a research brief',
        description:
          'Read a research brief: its pillars, settings, the planner\'s open questions and latest '
          + 'turn. Leave include_transcript off unless you need the whole conversation.',
        inputSchema: deepWaterToolInputSchemas.research_scope_get,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_scope_launch',
        label: 'Start the agreed research',
        description:
          'Start the research the brief describes, at its current revision, optionally with final '
          + 'edits. Start a brief once and never start a second research for the same question. '
          + 'Leave public unset: only a person can publish a report.',
        inputSchema: deepWaterToolInputSchemas.research_scope_launch,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_status',
        label: 'Read research status',
        description: 'Read the progress and final state of a DeepWater research.',
        inputSchema: deepWaterToolInputSchemas.research_status,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_report',
        label: 'Read research report',
        description:
          'Read the finished report and its references. report_kind=summary means the full report '
          + 'could not be written and this is the research summary.',
        inputSchema: deepWaterToolInputSchemas.research_report,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_cancel',
        label: 'Cancel research',
        description: 'Cancel a research brief that is still being agreed, or a research that is running.',
        inputSchema: deepWaterToolInputSchemas.research_cancel,
        privacyTier: 'sensitive',
        status: 'available',
      },
      {
        name: 'research_list',
        label: 'List research',
        description: 'List the DeepWater research the person you act for has asked for, newest first.',
        inputSchema: deepWaterToolInputSchemas.research_list,
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
