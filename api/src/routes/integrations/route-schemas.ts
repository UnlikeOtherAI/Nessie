import { z } from 'zod'

export const ProductSlugParamsSchema = z.object({
  productSlug: z.string().min(1),
})

export type DeepWaterLaunchInput = {
  artifactDestination: 'knowledge_draft' | 'chat_only'
  chapterDepth: 'brief' | 'standard' | 'detailed' | 'exhaustive'
  depth: 'light' | 'standard' | 'deep' | 'heavy' | 'thesis' | 'dissertation'
  outputLanguage: string
  outputTier: 'summary' | 'full'
  query: string
  recency: 'any' | 'day' | 'week' | 'month' | 'year'
  searchQuality: 'standard' | 'premium'
  searchesPerPillar: number
  sections: number
}

export type DeepTestReviewHandoffInput = {
  artifactPolicy: 'share_safe_report' | 'external_link_only'
  depth: 'shallow' | 'standard' | 'deep' | 'overnight'
  runner: 'local_mcp' | 'private_runner'
}

export type BuildMeProjectHandoffInput = {
  contextScope: 'active_project' | 'active_team'
  intent: 'project_definition' | 'development_workspace' | 'board_source_discovery'
}

export const normalizeDeepWaterLaunchInput = (
  input: Partial<DeepWaterLaunchInput> & { query: string },
): DeepWaterLaunchInput => ({
  artifactDestination: input.artifactDestination ?? 'knowledge_draft',
  chapterDepth: input.chapterDepth ?? 'standard',
  depth: input.depth ?? 'standard',
  outputLanguage: input.outputLanguage ?? 'en',
  outputTier: input.outputTier ?? 'full',
  query: input.query,
  recency: input.recency ?? 'any',
  searchQuality: input.searchQuality ?? 'standard',
  searchesPerPillar: input.searchesPerPillar ?? 4,
  sections: input.sections ?? 8,
})

export const normalizeDeepTestReviewHandoffInput = (
  input: Partial<DeepTestReviewHandoffInput>,
): DeepTestReviewHandoffInput => ({
  artifactPolicy: input.artifactPolicy ?? 'share_safe_report',
  depth: input.depth ?? 'standard',
  runner: input.runner ?? 'local_mcp',
})

export const normalizeBuildMeProjectHandoffInput = (
  input: Partial<BuildMeProjectHandoffInput>,
): BuildMeProjectHandoffInput => ({
  contextScope: input.contextScope ?? 'active_project',
  intent: input.intent ?? 'project_definition',
})
