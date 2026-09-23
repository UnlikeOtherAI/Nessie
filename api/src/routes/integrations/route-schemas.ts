import { z } from 'zod'

export const ProductSlugParamsSchema = z.object({
  productSlug: z.string().min(1),
})

export type DeepTestReviewHandoffInput = {
  artifactPolicy: 'share_safe_report' | 'external_link_only'
  depth: 'shallow' | 'standard' | 'deep' | 'overnight'
  runner: 'local_mcp' | 'private_runner'
}

export type BuildMeProjectHandoffInput = {
  contextScope: 'active_project' | 'active_team'
  intent: 'project_definition' | 'development_workspace' | 'board_source_discovery'
}

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
