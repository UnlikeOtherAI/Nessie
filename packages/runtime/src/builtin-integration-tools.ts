import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const DEEP_WATER_RUN_UPDATE_TOOL_ID = 'deep_water_run_update'

export const DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: DEEP_WATER_RUN_UPDATE_TOOL_ID,
  label: 'Deep Water Run Update',
  // Default OFF for every agent; grantable to any agent (personal assistant or
  // shared) through an explicit per-agent tool policy allow. A granted agent
  // that calls the DeepWater MCP tools writes the durable Nessie run record back
  // through this tool. `requiresExplicitGrant` makes exposure require an
  // explicit allow verdict — an absent/inherited policy does NOT expose it.
  requiresExplicitGrant: true,
  description:
    'Update Nessie\'s durable Deep Water run record after calling the approved Ledger MCP tools. ' +
    'Use the exact full Nessie runId from the server-built launch message, never the abbreviated value on its launch card; record the Ledger research job id, status, source count, exact immutable Ledger-booked terminal rate-card charge, report URL, and Knowledge draft page when available.',
  parameters: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'Exact full Nessie product_integration_runs UUID from the server-built Deep Water launch message; do not use the abbreviated launch-card display.',
      },
      status: {
        type: 'string',
        enum: ['running', 'needs_setup', 'completed', 'failed', 'warning'],
        description: 'Current Deep Water run status to project into Nessie.',
      },
      externalRunId: {
        type: 'string',
        description: 'Ledger research job id returned by mcp_research_start or mcp_research_status.',
      },
      sourceCount: {
        type: 'integer',
        minimum: 0,
        description: 'Number of sources/evidence items reported by Deep Water.',
      },
      totalCost: {
        type: 'number',
        minimum: 0,
        description: 'Optional immutable rate-card charge booked by Ledger. Copy it exactly; it is not a final provider-invoice actual and complex runs may reconcile higher upstream.',
      },
      currency: {
        type: 'string',
        description: 'Currency returned with Ledger cost.amount for the booked rate-card charge. Omit when Ledger returned no cost.',
      },
      reportUrl: {
        type: 'string',
        description: 'Public or authenticated Deep Water report URL, if returned.',
      },
      knowledgePageId: {
        type: 'string',
        description: 'Nessie Knowledge page id when a draft page has been created for the report.',
      },
      statusDetail: {
        type: 'string',
        description: 'Short human-readable progress or result detail.',
      },
    },
    required: ['runId', 'status'],
  },
  safe: true,
}

export const INTEGRATION_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION,
]
