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
): string => {
  const title = input.title?.trim()
  const depth = ledgerResearchDepth(input.depth)
  const recency = ledgerResearchRecency(input.recency)
  const destination =
    input.artifactDestination === 'knowledge_draft'
      ? [
          'Before drafting, call kb_list with no arguments and select an accessible writable spaceId returned by that call.',
          'Call kb_draft_write with that exact spaceId; never invent, guess, or reuse an unlisted spaceId.',
          'Draft the completed report and source summary into Knowledge, then request publication.',
        ].join(' ')
      : 'Summarize the result in this chat without creating a Knowledge draft.'

  return [
    'Run Deep Water research through the approved Ledger MCP connector. Do not call Deep Water directly; Ledger owns authorization, budget enforcement, and rate-card charge booking.',
    '',
    'Query:',
    input.query,
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
    'Call mcp_research_start with query, context, the Ledger depth above, and the Ledger recency above.',
    'After mcp_research_start returns its Ledger research job id, call deep_water_run_update with the Nessie run id, externalRunId set to that Ledger id, and status=running.',
    'You may call mcp_research_status once to confirm the job was accepted. Do not busy-poll, wait for completion, or consume this bounded agent run checking a long-running job.',
    'Tell the user the research is running, include the Ledger research job id, and end this turn.',
    'On a later user status request or follow-up turn, call mcp_research_status once with { id }. If it is still running, report progress and stop. Map Ledger status complete to Nessie status completed; map failed, cancelled, or timed_out to failed.',
    'Only when that later status response is complete, call mcp_research_report with { id } to read the report and references, then call deep_water_run_update with completed status, sourceCount, statusDetail, and knowledgePageId if you drafted a Knowledge page.',
    'If a terminal Ledger response includes cost, copy cost.amount exactly to totalCost and cost.currency exactly to currency. This is Ledger\'s immutable booked rate-card charge, not an upstream provider-invoice actual; complex runs may reconcile to a higher provider amount without changing the booked charge mirrored here. If cost is absent, omit both fields. Never estimate cost or present the booked charge as final provider invoice actuals.',
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
      summary: 'Personal Assistant will start this through Ledger MCP; Ledger books the research rate-card charge.',
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
