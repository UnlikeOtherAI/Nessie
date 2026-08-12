import type {
  ToolGrantSource,
  ToolRegistrySource,
} from '@nessie/schemas'

/**
 * Wire ↔ Prisma enum mapping for tool-registry enums.
 *
 * Postgres stores `mcp-remote` / `agent-override` (kebab-case) for backwards
 * compatibility with the spec; Prisma's generated client renames these to
 * `mcp_remote` / `agent_override` because Prisma enums can't contain dashes.
 *
 * Every service that reads/writes these enums through Prisma must translate
 * with these helpers — keep wire types as the source of truth so external
 * callers (admin UI, HTTP clients, JSON contracts) never see the Prisma alias.
 */

const TO_PRISMA_TOOL_REGISTRY_SOURCE: Record<ToolRegistrySource, string> = {
  builtin: 'builtin',
  custom: 'custom',
  'mcp-remote': 'mcp_remote',
  'interactive-session': 'interactive_session',
  executor: 'executor',
}

const FROM_PRISMA_TOOL_REGISTRY_SOURCE: Record<string, ToolRegistrySource> = {
  builtin: 'builtin',
  custom: 'custom',
  mcp_remote: 'mcp-remote',
  interactive_session: 'interactive-session',
  executor: 'executor',
}

const TO_PRISMA_TOOL_GRANT_SOURCE: Record<ToolGrantSource, string> = {
  role: 'role',
  'agent-override': 'agent_override',
}

const FROM_PRISMA_TOOL_GRANT_SOURCE: Record<string, ToolGrantSource> = {
  role: 'role',
  agent_override: 'agent-override',
}

export const toPrismaToolRegistrySource = (value: ToolRegistrySource): string =>
  TO_PRISMA_TOOL_REGISTRY_SOURCE[value]

export const fromPrismaToolRegistrySource = (value: string): ToolRegistrySource => {
  const mapped = FROM_PRISMA_TOOL_REGISTRY_SOURCE[value]
  if (!mapped) {
    throw new Error(`Unknown Prisma ToolRegistrySource value: ${value}`)
  }
  return mapped
}

export const toPrismaToolGrantSource = (value: ToolGrantSource): string =>
  TO_PRISMA_TOOL_GRANT_SOURCE[value]

export const fromPrismaToolGrantSource = (value: string): ToolGrantSource => {
  const mapped = FROM_PRISMA_TOOL_GRANT_SOURCE[value]
  if (!mapped) {
    throw new Error(`Unknown Prisma ToolGrantSource value: ${value}`)
  }
  return mapped
}
