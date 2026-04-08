import type { ToolDescriptor } from '../contracts.js'

const SAFE_TOOLS: ToolDescriptor[] = [
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

export const listSafeTools = (): ToolDescriptor[] => SAFE_TOOLS
