import { IntegrationUiCardSchema } from '@nessie/schemas'

import type {
  BuildMeProjectHandoffInput,
  DeepTestReviewHandoffInput,
  DeepWaterLaunchInput,
} from './route-schemas.js'

const ledgerResearchDepth = (
  depth: DeepWaterLaunchInput['depth'],
): 'light' | 'standard' | 'deep' | 'heavy' =>
  depth === 'thesis' || depth === 'dissertation' ? 'heavy' : depth

const ledgerResearchRecency = (
  recency: DeepWaterLaunchInput['recency'],
): 'any' | 'recent' => recency === 'any' ? 'any' : 'recent'

export const buildDeepWaterLaunchMessage = (
  input: DeepWaterLaunchInput,
  context: { runId: string },
): string => {
  const title = input.title?.trim()
  const depth = ledgerResearchDepth(input.depth)
  const recency = ledgerResearchRecency(input.recency)
  const destination =
    input.artifactDestination === 'knowledge_draft'
      ? [
          'Only after the terminal run update succeeds, call kb_list with no arguments and select an accessible writable spaceId returned by that call.',
          'Call kb_draft_write with that exact spaceId; never invent, guess, or reuse an unlisted spaceId.',
          'Keep the Knowledge tool call bounded: draft a concise completed-report summary, source summary, and Ledger research job id instead of copying an unbounded report through model-generated tool arguments.',
          'Request publication for the agent-authored draft.',
          'After a Knowledge page is created, call deep_water_run_update again with the same Nessie run id, Ledger externalRunId, completed status, and knowledgePageId. This second update only attaches the page.',
        ].join(' ')
      : 'Summarize the result in this chat without creating a Knowledge draft.'

  return [
    'Run Deep Water research through the approved Ledger MCP connector. Do not call Deep Water directly; Ledger owns authorization, budget enforcement, and raw usage metering.',
    '',
    'Query:',
    input.query,
    '',
    'Nessie durable research run id (use this exact full UUID for every deep_water_run_update call):',
    context.runId,
    '',
    'Ledger MCP arguments:',
    `Depth: ${depth}`,
    `Recency: ${recency}`,
    '',
    'Pass this launcher detail as the optional context string (not as extra top-level tool arguments):',
    title ? `Title: ${title}` : null,
    `Chapter depth: ${input.chapterDepth}`,
    `Output tier: ${input.outputTier}`,
    `Output language: ${input.outputLanguage}`,
    `Search quality: ${input.searchQuality}`,
    `Sections: ${input.sections}`,
    `Searches per pillar: ${input.searchesPerPillar}`,
    '',
    'Handle this launch in the current agent. Do not use delegate; Nessie keeps delegation blocked for deterministic ticket delivery.',
    'Call mcp_research_start with query, context, the Ledger depth above, and the Ledger recency above.',
    'Nessie durably binds the first mcp_research_start tool-call id and exact arguments to this launch and permits only that logical start. A validated Ledger-local invalid-request, permission, or budget rejection is recorded failed automatically; tell the user the research was rejected and stop without calling deep_water_run_update, status, report, or Knowledge tools. A throw, timeout, conflict, upstream rejection, 5xx, malformed error, or successful response without matching usable Ledger id, job_id, and supported status fields is ambiguous, not a confirmed failure: do not retry it yourself or call dependent tools. Nessie retries with the exact saved id and arguments, moves exhausted ambiguity to needs_setup, and may replay an already-persisted Ledger ticket with its exact status as a local successful result.',
    'After mcp_research_start returns, inspect its status. If status is running, call deep_water_run_update with runId set to the exact full Nessie durable research run id above, externalRunId set to the Ledger id, and status=running. If status is complete, failed, cancelled, or timed_out, never overwrite it with running: call mcp_research_status once with that Ledger id to retrieve authoritative terminal detail, then perform the mandatory mapped terminal deep_water_run_update described below.',
    'For a running ticket, you may call mcp_research_status once to confirm the job was accepted. Do not busy-poll, wait for completion, or consume this bounded agent run checking a long-running job.',
    'When the ticket remains running, tell the user the research is running, include the Ledger research job id, and end this turn.',
    'On a later user status request or follow-up turn, call mcp_research_status once with { id }. If it is still running, report progress and stop. Map Ledger status complete to Nessie status completed; map failed, cancelled, or timed_out to failed.',
    'Whenever that status response is complete, including after a terminal replay, call mcp_research_report with { id } to read the report and references.',
    'Nessie independently validates and records the matching report_url from the authenticated mcp_research_start response and the source count from the authenticated mcp_research_report references array. Do not pass, invent, infer, or replace either value in deep_water_run_update.',
    'Immediately after resolving the terminal status, report, and status detail, call deep_water_run_update with the terminal status. This update is mandatory and must succeed before any optional Knowledge drafting starts.',
    'If the Ledger status is failed, cancelled, or timed_out, call deep_water_run_update with failed status and the terminal status detail before ending the turn.',
    'Do not pass a cost, price, charge, tariff, or currency to deep_water_run_update. Ledger exposes raw metering only and UOA is the sole source for commercial amounts.',
    'Never invent usage fields, reuse another user\'s job id, or bypass Ledger by calling the upstream provider directly.',
    'When reporting back, include the Nessie run id, Ledger research job id, status, source count, and native Knowledge link when one was created.',
    'If you set knowledgePageId, also tell the user the report now lives as a native Knowledge document and link it as /knowledge-base?pageId=<knowledgePageId> so they can open it without leaving Nessie.',
    destination,
  ].filter((line): line is string => line !== null).join('\n')
}

export const buildDeepWaterLaunchMetadata = (
  input: DeepWaterLaunchInput,
  context: { channelId: string; connectorId: string; productSlug: string; runId: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactDestination: input.artifactDestination,
    connectorId: context.connectorId,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
    runId: context.runId,
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
      ],
      fields: [
        { label: 'Depth', value: input.depth },
        { label: 'Output', value: input.outputTier },
        {
          label: 'Destination',
          value: input.artifactDestination === 'knowledge_draft' ? 'Knowledge draft' : 'Chat',
        },
        { label: 'Connector', value: 'Ledger MCP active' },
        { label: 'Run', value: context.runId.slice(0, 8) },
      ],
      kind: 'deep_research',
      productSlug: 'deep-water',
      status: 'queued',
      summary: 'Personal Assistant will start this through Ledger MCP; Ledger records the raw research usage for UOA.',
      title: input.title?.trim() || 'Deep Water research',
    }),
  ],
})

export const buildDeepTestReviewHandoffMessage = (
  input: DeepTestReviewHandoffInput,
): string => {
  const artifactPolicy =
    input.artifactPolicy === 'share_safe_report'
      ? 'Import only a share-safe, target-neutral report into Knowledge if the local runner returns one.'
      : 'Keep artifacts in DeepTest and link out; do not import reports into Nessie.'

  return [
    'Prepare a DeepTest security review through the approved local MCP connector.',
    '',
    `Depth: ${input.depth}`,
    `Runner: ${input.runner}`,
    `Artifact policy: ${input.artifactPolicy}`,
    '',
    'Privacy boundary:',
    '- Do not ask the user to paste target URLs, source code, PR diffs, findings, prompts, secrets, or raw reports into Nessie.',
    '- The user must configure the target inside DeepTest or its local runner.',
    '- Use mcp_deeptest_review only after the local runner and approved tool grant are available.',
    '- If a report is returned, summarize only status, controlled counts, neutral next steps, and share-safe artifacts.',
    artifactPolicy,
  ].join('\n')
}

export const buildDeepTestReviewHandoffMetadata = (
  input: DeepTestReviewHandoffInput,
  context: { channelId: string; connectorId: string; launchUrl: string | null; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactPolicy: input.artifactPolicy,
    connectorId: context.connectorId,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
        ...(context.launchUrl
          ? [{ href: context.launchUrl, label: 'Open DeepTest', variant: 'secondary' as const }]
          : []),
      ],
      fields: [
        { label: 'Depth', value: input.depth },
        {
          label: 'Import',
          value: input.artifactPolicy === 'share_safe_report' ? 'Share-safe only' : 'Link only',
        },
        { label: 'Runner', value: input.runner === 'local_mcp' ? 'Local MCP' : 'Private runner' },
        { label: 'Boundary', value: 'No target material in Nessie' },
      ],
      kind: 'security_review',
      productSlug: 'deeptest',
      status: 'queued',
      summary: 'Personal Assistant will use DeepTest MCP while keeping target material local.',
      title: 'DeepTest security review',
    }),
  ],
})

export const buildBuildMeProjectHandoffMessage = (
  input: BuildMeProjectHandoffInput,
  launchUrl: string | null,
): string => {
  const intent = input.intent.replace(/_/g, ' ')
  const scope =
    input.contextScope === 'active_project'
      ? 'Use only the active Nessie project/team as context.'
      : 'Use only the active Nessie team as context.'

  return [
    'Prepare a buildme.live project handoff.',
    '',
    `Intent: ${intent}`,
    `Context scope: ${input.contextScope}`,
    launchUrl ? `Launch URL: ${launchUrl}` : null,
    '',
    'Boundary:',
    '- Use UOA SSO link-out for the BuildMe workspace.',
    '- Do not create, sync, or mutate Nessie project-board columns from BuildMe yet.',
    '- Do not ask the user to paste BuildMe board payloads, card lists, column mappings, credentials, or workspace files into Nessie.',
    '- If the user asks for native board pairing, explain that it needs the BuildMe board API/MCP contract first.',
    scope,
  ].filter((line): line is string => line !== null).join('\n')
}

export const buildBuildMeProjectHandoffMetadata = (
  input: BuildMeProjectHandoffInput,
  context: { channelId: string; launchUrl: string | null; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    contextScope: input.contextScope,
    intent: input.intent,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
  },
  mentions: { agentIds: [], broadcast: null, userIds: [] },
  uiCards: [
    IntegrationUiCardSchema.parse({
      actions: [
        { href: `/channels/${context.channelId}`, label: 'Open chat', variant: 'primary' },
        ...(context.launchUrl
          ? [{ href: context.launchUrl, label: 'Open buildme.live', variant: 'secondary' as const }]
          : []),
      ],
      fields: [
        { label: 'Intent', value: input.intent.replace(/_/g, ' ') },
        {
          label: 'Context',
          value: input.contextScope === 'active_project' ? 'Active project' : 'Active team',
        },
        { label: 'SSO', value: 'UOA linked' },
        { label: 'Board API', value: 'Contract pending' },
      ],
      kind: 'project_board',
      productSlug: 'buildme',
      status: 'needs_setup',
      summary: 'Personal Assistant will prepare a link-out handoff and keep board sync blocked.',
      title: 'buildme.live project handoff',
    }),
  ],
})
