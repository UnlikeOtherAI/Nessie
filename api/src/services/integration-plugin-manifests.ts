import {
  IntegrationPluginManifestSchema,
  type IntegrationPluginManifest,
} from '@nessie/schemas'

import { deepWaterIntegrationPluginManifest } from './integration-plugin-manifests/deep-water.js'

const rawManifests = [
  deepWaterIntegrationPluginManifest,
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
        setup: 'Expose the local DeepTest stdio MCP server through an approved private runner or loopback bridge.',
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
          status: 'available',
        },
        {
          name: 'get_deeptest_share_safe_repo_security_scan',
          label: 'Read share-safe scan',
          description: 'Return a target-neutral share-safe single-scan report projection.',
          privacyTier: 'sensitive',
          status: 'available',
        },
        {
          name: 'get_deeptest_share_safe_repo_security_scan_suite',
          label: 'Read share-safe suite',
          description: 'Return a target-neutral share-safe multi-report suite projection.',
          privacyTier: 'sensitive',
          status: 'available',
        },
        {
          name: 'prepare_usage_metering_event',
          label: 'Prepare metering event',
          description: 'Create content-free metering metadata for local DeepTest usage.',
          privacyTier: 'normal',
          status: 'available',
        },
      ],
    },
    ui: {
      pages: [
        { id: 'security-handoff', label: 'Security review handoff', status: 'available' },
        { id: 'runner-status', label: 'Runner status', status: 'available' },
        { id: 'review-history', label: 'Review history', status: 'planned' },
      ],
      cards: [
        { kind: 'security_review', label: 'Security review summary', status: 'available' },
        { kind: 'integration', label: 'Runner/setup status', status: 'available' },
      ],
      controls: [
        { id: 'review-depth', label: 'Review depth', status: 'available' },
        { id: 'runner-boundary', label: 'Runner boundary', status: 'available' },
        { id: 'share-safe-import', label: 'Share-safe import', status: 'available' },
      ],
    },
    surfaces: [],
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
        mode: 'hosted_preinstall',
        availability: 'both',
        label: 'Per-user external agent',
        requiredForAgentUse: true,
        setup:
          'Activate DeepSignal using your linked Nessie SSO identity. '
          + 'Nessie authenticates with its dedicated DeepSignal app key and '
          + 'delegates your active organization/team on every request.',
      },
    ],
    mcp: {
      catalogTemplate: {
        name: 'deepsignal',
        label: 'DeepSignal',
        protocol: 'http',
        authMethod: 'bearer',
        transport: { transport: 'http', url: 'https://api.deepsignal.live/mcp' },
        auth: { method: 'bearer' },
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
    conversationStarters: [
      'What signals need my attention today?',
      "Summarize this week's risks and opportunities",
      'What changed since I last checked?',
    ],
    surfaces: [
      {
        type: 'chat_assistant',
        channelKind: 'external_agent',
        productSlug: 'deepsignal',
        label: 'DeepSignal',
        // A non-human product glyph (not a person avatar) + a function-first
        // one-liner: lead with what it does, per Slack agent-design.
        iconGlyph: '◎',
        description: "Surfaces the signals and decisions you shouldn't miss",
        // The per-user private DeepSignal channel appears under the Personal
        // Assistant only once the user has activated + signed in (account
        // linked) and the external-agent capability is present.
        requires: { capability: 'external_agent', linked: true },
      },
    ],
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
        { id: 'link-handoff', label: 'Link-out handoff', status: 'available' },
        { id: 'project-source-pairing', label: 'Project source pairing', status: 'planned' },
      ],
      cards: [
        { kind: 'project_board', label: 'Board source readiness', status: 'available' },
        { kind: 'integration', label: 'Link-out/account status', status: 'available' },
      ],
      controls: [
        { id: 'handoff-intent', label: 'Handoff intent', status: 'available' },
        { id: 'context-scope', label: 'Context scope', status: 'available' },
        { id: 'column-mapping', label: 'Column mapping', status: 'blocked' },
        { id: 'conflict-policy', label: 'Conflict policy', status: 'blocked' },
      ],
    },
    surfaces: [],
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
