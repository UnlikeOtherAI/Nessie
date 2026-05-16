import type {
  NessieToolBundle,
  NessieToolBundleTool,
  NormalizedTool,
  PromptMergeMode,
} from './types.js'

const DEFAULT_BASE_PROMPT_CONTENT = ''
const DEFAULT_BASE_PROMPT_MERGE_MODE: PromptMergeMode = 'append'

/**
 * Project a validated `NessieToolBundle` into one `NormalizedTool` per
 * declared tool, applying defaults and ensuring stable field order so callers
 * can hash records for change detection.
 */
export const normalizeBundle = (bundle: NessieToolBundle): NormalizedTool[] =>
  bundle.tools.map((tool) => normalizeTool(bundle, tool))

const normalizeTool = (
  bundle: NessieToolBundle,
  tool: NessieToolBundleTool,
): NormalizedTool => {
  // Object literal property order matters: stringify produces a deterministic
  // representation that callers hash for upsert change detection.
  return {
    id: tool.id,
    bundleId: bundle.metadata.id,
    bundleName: bundle.metadata.name,
    bundleVersion: bundle.metadata.version,
    toolName: tool.toolName,
    label: tool.label,
    overview: tool.overview,
    instructions: tool.instructions ?? '',
    source: tool.source,
    transport: tool.transport,
    transportConfig: tool.transportConfig ?? {},
    inputSchema: tool.inputSchema,
    enabled: tool.enabled ?? true,
    grant: tool.grants
      ? {
          allowed: tool.grants.allowed,
          config: tool.grants.config ?? {},
        }
      : null,
    basePrompt: tool.basePrompt ?? {
      content: DEFAULT_BASE_PROMPT_CONTENT,
      mergeMode: DEFAULT_BASE_PROMPT_MERGE_MODE,
    },
    commonPrompt: tool.commonPrompt
      ? {
          enabledPrompt: tool.commonPrompt.enabledPrompt,
          overrideMode: tool.commonPrompt.overrideMode,
        }
      : null,
    tags: tool.tags ?? [],
    baseSearchTerms: tool.baseSearchTerms ?? [],
    allowSearchTerms: tool.allowSearchTerms ?? [],
    createdBy: tool.createdBy ?? 'system',
    owner: tool.owner ?? bundle.metadata.id,
  }
}
