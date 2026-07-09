import { IntegrationUiCardSchema } from '@nessie/schemas'

import type {
  BuildMeProjectHandoffInput,
  DeepTestReviewHandoffInput,
  DeepWaterLaunchInput,
} from './route-schemas.js'

export const buildDeepWaterLaunchMessage = (
  input: DeepWaterLaunchInput,
): string => {
  const title = input.title?.trim()
  const destination =
    input.artifactDestination === 'knowledge_draft'
      ? 'Draft the completed report and source summary into Knowledge, then request publication.'
      : 'Summarize the result in this chat without creating a Knowledge draft.'

  return [
    'Run Deep Water research through the approved MCP connector.',
    '',
    title ? `Title: ${title}` : null,
    `Depth: ${input.depth}`,
    `Chapter depth: ${input.chapterDepth}`,
    `Output tier: ${input.outputTier}`,
    `Output language: ${input.outputLanguage}`,
    `Search quality: ${input.searchQuality}`,
    `Recency: ${input.recency}`,
    `Sections: ${input.sections}`,
    `Searches per pillar: ${input.searchesPerPillar}`,
    '',
    'Query:',
    input.query,
    '',
    'Use mcp_research_create with these settings, then poll with mcp_research_get until the job reaches a terminal state.',
    'When reporting back, include the Deep Water run id, status, source count, and any usage/cost fields returned by the tool.',
    destination,
  ].filter((line): line is string => line !== null).join('\n')
}

export const buildDeepWaterLaunchMetadata = (
  input: DeepWaterLaunchInput,
  context: { channelId: string; connectorId: string; productSlug: string },
): Record<string, unknown> => ({
  integrationLaunch: {
    artifactDestination: input.artifactDestination,
    connectorId: context.connectorId,
    productSlug: context.productSlug,
    requestedAt: new Date().toISOString(),
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
        { label: 'Connector', value: 'MCP active' },
      ],
      kind: 'deep_research',
      productSlug: 'deep-water',
      status: 'queued',
      summary: 'Personal Assistant will launch this through Deep Water MCP and report progress here.',
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
