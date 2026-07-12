import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'deep_water_run_update',
  label: 'Deep Water Run Update',
  // Available to any granted agent (personal assistant or shared): a shared
  // agent that calls the DeepWater MCP tools writes the durable Nessie run
  // record back through this tool. Grant is still per-agent (default off).
  description:
    'Update Nessie\'s durable Deep Water run record after calling the approved Deep Water MCP tools. ' +
    'Use this with the Nessie runId from the launch card; record the external Deep Water run id, status, source count, cost, report URL, and Knowledge draft page when available.',
  parameters: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'Nessie product_integration_runs id from the Deep Water launch card.',
      },
      status: {
        type: 'string',
        enum: ['running', 'needs_setup', 'completed', 'failed', 'warning'],
        description: 'Current Deep Water run status to project into Nessie.',
      },
      externalRunId: {
        type: 'string',
        description: 'Deep Water research/run id returned by mcp_research_create or mcp_research_get.',
      },
      sourceCount: {
        type: 'integer',
        minimum: 0,
        description: 'Number of sources/evidence items reported by Deep Water.',
      },
      totalCost: {
        type: 'number',
        minimum: 0,
        description: 'Total Deep Water cost or usage charge for the run.',
      },
      currency: {
        type: 'string',
        description: 'ISO currency code for totalCost, default USD when omitted.',
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
