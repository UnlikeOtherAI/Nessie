import {
  IntegrationPluginManifestSchema,
  type IntegrationPluginManifest,
} from '@nessie/schemas'

const rawManifests = [
  {
    apiVersion: 'integrations.nessie.io/v1',
    kind: 'NessieIntegrationPlugin',
    manifestRef: 'first-party/deep-water',
    productSlug: 'deep-water',
    name: 'Deep Water',
    version: '0.1.0',
    vendor: 'UnlikeOtherAI',
    install: [
      {
        mode: 'hosted_preinstall',
        availability: 'hosted',
        label: 'Hosted native research',
        requiredForAgentUse: true,
        setup: 'Bind the Deep Water OAuth MCP server to the active team/workspace.',
      },
      {
        mode: 'api_key',
        availability: 'self_hosted',
        label: 'Self-hosted API credential',
        requiredForAgentUse: true,
        setup: 'Store a Deep Water API key as a secret ref and install the MCP catalog entry.',
      },
    ],
    mcp: {
      catalogTemplate: {
        name: 'deep-water',
        label: 'Deep Water',
        protocol: 'http',
        authMethod: 'oauth2',
        transport: { transport: 'http', urlEnv: 'DEEP_WATER_MCP_URL' },
        auth: { method: 'oauth2', scopes: ['research:create', 'research:read', 'usage:read'] },
      },
      toolBundleRef: 'first-party/deep-water-tools',
      tools: [
        {
          name: 'deep_water_create_research',
          label: 'Create research',
          description: 'Start an async Deep Water research run from an approved agent.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
        {
          name: 'deep_water_get_research',
          label: 'Poll research',
          description: 'Read run progress, completion state, and report metadata.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
        {
          name: 'deep_water_get_usage',
          label: 'Read usage',
          description: 'Return cost and usage details for research jobs.',
          privacyTier: 'normal',
          status: 'planned',
        },
      ],
    },
    ui: {
      pages: [
        { id: 'research-runs', label: 'Research runs', status: 'planned' },
        { id: 'research-sources', label: 'Sources and evidence', status: 'planned' },
      ],
      cards: [
        { kind: 'deep_research', label: 'Research progress/result', status: 'available' },
        { kind: 'integration', label: 'Usage and setup status', status: 'available' },
      ],
      controls: [
        { id: 'research-depth', label: 'Depth', status: 'planned' },
        { id: 'budget-cap', label: 'Budget cap', status: 'planned' },
        { id: 'artifact-destination', label: 'Knowledge destination', status: 'planned' },
      ],
    },
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
      costFields: ['providerReportedCost', 'currency', 'runId'],
    },
  },
  {
    apiVersion: 'integrations.nessie.io/v1',
    kind: 'NessieIntegrationPlugin',
    manifestRef: 'first-party/deeptest',
    productSlug: 'deeptest',
    name: 'DeepTest',
    version: '0.1.0',
    vendor: 'UnlikeOtherAI',
    install: [
      {
        mode: 'local_mcp',
        availability: 'self_hosted',
        label: 'Local MCP runner',
        requiredForAgentUse: true,
        setup: 'Connect a local DeepTest MCP endpoint from the user machine or a private runner.',
      },
      {
        mode: 'link_out',
        availability: 'both',
        label: 'DeepTest workspace',
        requiredForAgentUse: false,
        setup: 'Open deeptest.live or a local DeepTest workspace for review details.',
      },
    ],
    mcp: {
      catalogTemplate: {
        name: 'deeptest',
        label: 'DeepTest',
        protocol: 'http',
        authMethod: 'none',
        transport: { transport: 'http', urlEnv: 'DEEPTEST_MCP_URL', localOnly: true },
        auth: { method: 'none' },
      },
      toolBundleRef: 'first-party/deeptest-tools',
      tools: [
        {
          name: 'deeptest_review',
          label: 'Run security review',
          description: 'Run the recommended DeepTest review flow through an approved local runner.',
          privacyTier: 'local_only',
          status: 'planned',
        },
        {
          name: 'deeptest_share_safe_report',
          label: 'Read share-safe report',
          description: 'Return only content-minimized report metadata and share-safe output.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
      ],
    },
    ui: {
      pages: [
        { id: 'runner-status', label: 'Runner status', status: 'planned' },
        { id: 'review-history', label: 'Review history', status: 'planned' },
      ],
      cards: [
        { kind: 'security_review', label: 'Security review summary', status: 'available' },
        { kind: 'integration', label: 'Runner/setup status', status: 'available' },
      ],
      controls: [
        { id: 'review-profile', label: 'Review profile', status: 'planned' },
        { id: 'share-safe-import', label: 'Share-safe import', status: 'planned' },
      ],
    },
    artifacts: [
      {
        kind: 'share_safe_report',
        label: 'Share-safe report',
        defaultDestination: 'Knowledge',
        fileServiceRequired: false,
      },
      {
        kind: 'owner_local_report',
        label: 'Owner-local report link',
        defaultDestination: 'External link',
        fileServiceRequired: false,
      },
    ],
    privacy: {
      dataBoundary: 'Target material remains local/session-scoped unless explicitly imported.',
      defaultImportPolicy: 'Only share-safe report artifacts enter Nessie by default.',
      prohibitedByDefault: ['target URLs', 'source code', 'raw PR diffs', 'raw findings', 'prompts'],
    },
    usage: {
      ledger: 'connector_usage_events',
      connectorType: 'mcp',
      costFields: ['contentFreeMeter', 'reviewId'],
    },
  },
  {
    apiVersion: 'integrations.nessie.io/v1',
    kind: 'NessieIntegrationPlugin',
    manifestRef: 'first-party/deepsignal',
    productSlug: 'deepsignal',
    name: 'DeepSignal',
    version: '0.1.0',
    vendor: 'UnlikeOtherAI',
    install: [
      {
        mode: 'remote_mcp_oauth',
        availability: 'both',
        label: 'Per-user external agent',
        requiredForAgentUse: true,
        setup: 'Activate DeepSignal for yourself and sign in with your account so each turn is proxied to DeepSignal over MCP under your own identity.',
      },
    ],
    mcp: {
      catalogTemplate: {
        name: 'deepsignal',
        label: 'DeepSignal',
        protocol: 'http',
        authMethod: 'oauth2',
        transport: { transport: 'http', url: 'https://api.deepsignal.live/mcp' },
        auth: { method: 'oauth2' },
      },
      toolBundleRef: 'first-party/deepsignal-tools',
      tools: [
        {
          name: 'chat',
          label: 'Chat',
          description: 'Send a conversation turn to DeepSignal and receive the reply and activity cards. Nessie never runs inference for this turn.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
        {
          name: 'conversation_list',
          label: 'List conversations',
          description: 'List the DeepSignal conversations for the linked user.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
        {
          name: 'conversation_history',
          label: 'Read conversation history',
          description: 'Read past turns of a DeepSignal conversation, including turns made on other surfaces, for history hydration.',
          privacyTier: 'sensitive',
          status: 'planned',
        },
        {
          name: 'insight_digest',
          label: 'Read insight digest',
          description: 'Pull the digest of surfaced opportunities and risks the user should not miss.',
          privacyTier: 'normal',
          status: 'planned',
        },
        {
          name: 'insight_act',
          label: 'Act on an insight',
          description: 'Mark an insight done or snooze it; the action is proxied back to DeepSignal.',
          privacyTier: 'normal',
          status: 'planned',
        },
        {
          name: 'api_research',
          label: 'Research reference',
          description: 'Resolve DeepWater research references (api_research_*) DeepSignal holds as ids, for read-only deep-linking.',
          privacyTier: 'normal',
          status: 'planned',
        },
      ],
    },
    ui: {
      pages: [
        { id: 'insight-digest', label: 'Insight digest', status: 'planned' },
      ],
      cards: [
        { kind: 'integration', label: 'Insight', status: 'planned' },
        { kind: 'integration', label: 'Conversation activity', status: 'planned' },
      ],
      controls: [
        { id: 'activate', label: 'Activate for me', status: 'available' },
      ],
    },
    artifacts: [
      {
        kind: 'research_reference',
        label: 'DeepWater report reference',
        defaultDestination: 'External link',
        fileServiceRequired: false,
      },
    ],
    privacy: {
      dataBoundary: 'Conversation content, insights, and pursuits live in DeepSignal; Nessie mirrors turns for display and notification only, keyed by DeepSignal ids.',
      defaultImportPolicy: 'Nessie stores mirrored turns and insight cards for the linked user only; edits and actions flow back over MCP, never applied locally-only.',
      prohibitedByDefault: ['Nessie inference on DeepSignal turns', 'shared/org-scope install of the chat surface', 'service-account impersonation'],
    },
    usage: {
      ledger: 'connector_usage_events',
      connectorType: 'mcp',
      costFields: ['conversationId', 'turnId'],
    },
  },
  {
    apiVersion: 'integrations.nessie.io/v1',
    kind: 'NessieIntegrationPlugin',
    manifestRef: 'first-party/buildme',
    productSlug: 'buildme',
    name: 'buildme.live',
    version: '0.1.0',
    vendor: 'UnlikeOtherAI',
    install: [
      {
        mode: 'link_out',
        availability: 'both',
        label: 'Launch buildme.live',
        requiredForAgentUse: false,
        setup: 'Use UOA SSO to open the BuildMe project-definition workspace.',
      },
      {
        mode: 'native_data_source',
        availability: 'both',
        label: 'Project board source',
        requiredForAgentUse: true,
        setup: 'Wait for BuildMe to publish the project-board API contract.',
      },
    ],
    mcp: {
      catalogTemplate: null,
      toolBundleRef: 'first-party/buildme-tools',
      tools: [
        {
          name: 'buildme_list_boards',
          label: 'List BuildMe boards',
          description: 'Read BuildMe projects, boards, columns, and cards for pairing.',
          privacyTier: 'sensitive',
          status: 'blocked',
        },
        {
          name: 'buildme_sync_board',
          label: 'Sync board',
          description: 'Render paired BuildMe columns in a Nessie project board.',
          privacyTier: 'sensitive',
          status: 'blocked',
        },
      ],
    },
    ui: {
      pages: [
        { id: 'project-source-pairing', label: 'Project source pairing', status: 'blocked' },
      ],
      cards: [
        { kind: 'project_board', label: 'Board sync status', status: 'planned' },
        { kind: 'integration', label: 'Link-out/account status', status: 'available' },
      ],
      controls: [
        { id: 'column-mapping', label: 'Column mapping', status: 'blocked' },
        { id: 'conflict-policy', label: 'Conflict policy', status: 'blocked' },
      ],
    },
    artifacts: [
      {
        kind: 'external_project_link',
        label: 'BuildMe project link',
        defaultDestination: 'Nessie project metadata',
        fileServiceRequired: false,
      },
    ],
    privacy: {
      dataBoundary: 'Project metadata can be read after account linking and explicit board pairing.',
      defaultImportPolicy: 'Read-only board rendering until column mapping and conflict handling are proven.',
      prohibitedByDefault: ['bidirectional writes', 'unmapped assignee updates', 'silent conflict resolution'],
    },
    usage: {
      ledger: 'connector_usage_events',
      connectorType: 'http',
      costFields: ['requestCount', 'syncId'],
    },
  },
] satisfies IntegrationPluginManifest[]

export const integrationPluginManifests = rawManifests.map((manifest) =>
  IntegrationPluginManifestSchema.parse(manifest),
)

const manifestBySlug = new Map(
  integrationPluginManifests.map((manifest) => [manifest.productSlug, manifest]),
)

export const getIntegrationPluginManifest = (
  productSlug: string,
): IntegrationPluginManifest | null => manifestBySlug.get(productSlug) ?? null
