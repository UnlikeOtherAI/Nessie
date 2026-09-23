import type { IntegrationPluginManifest } from '@nessie/schemas'

import { deepWaterToolInputSchemas } from './deep-water-tool-schemas.js'

/**
 * DeepWater's brief-first tool contract (Water plan contract D8, §5.2; manifest
 * 0.3.0): every research Nessie starts is agreed with DeepWater's planner
 * first, so these eight tools replace `research_start`. The manifest projects
 * exactly this list.
 *
 * It is proven equal to Ledger's published `tools/list`
 * (`deep-water.ledger-contract.json`, copied byte-for-byte from Ledger's
 * `docs/contracts/deepwater-mcp-tools.json`). Ledger serves these tools from
 * its brief release (phase C), which must be deployed before this contract
 * reaches Nessie production. A team still on the launcher contract upgrades in
 * place on its owner's next enable (`ensureDeepWaterTeamInstance`, amendments
 * N9.1), once no launcher run could still dispatch `research_start`.
 */

export type DeepWaterManifestTool = IntegrationPluginManifest['mcp']['tools'][number]

export const DEEP_WATER_BRIEF_CONTRACT_VERSION = '0.3.0'

/**
 * The launcher contract (manifest 0.2): the tool names a team projected before
 * research briefs. Kept so a team still on it is recognised as an older Ledger
 * contract to upgrade in place, not a foreign one to replace.
 */
export const DEEP_WATER_LAUNCHER_TOOL_NAMES: readonly string[] = [
  'research_start',
  'research_status',
  'research_report',
  'research_list',
  'research_cancel',
]

export const deepWaterBriefTools: DeepWaterManifestTool[] = [
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
]

export const DEEP_WATER_BRIEF_TOOL_NAMES: readonly string[] = deepWaterBriefTools.map((tool) => tool.name)
