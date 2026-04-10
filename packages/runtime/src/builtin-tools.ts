export type BuiltinToolDefinition = {
  description: string
  id: 'document_read' | 'web_fetch' | 'web_search'
  label: string
  safe: boolean
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Search the public web for relevant information.',
    safe: true,
  },
  {
    id: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch a public URL for deterministic reading.',
    safe: true,
  },
  {
    id: 'document_read',
    label: 'Document Read',
    description: 'Read project-local documents through the safe document adapter.',
    safe: true,
  },
]

export const BUILTIN_TOOL_IDS = new Set(
  BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id),
)
