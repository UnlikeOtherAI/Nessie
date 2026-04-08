import { useState } from 'react'

type ToolDef = {
  description: string
  id: string
  name: string
}

type ToolCategory = {
  id: string
  name: string
  tools: readonly ToolDef[]
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    id: 'system',
    name: 'System',
    tools: [
      { id: 'bash', name: 'Bash', description: 'Execute shell commands' },
      { id: 'file-read', name: 'File Read', description: 'Read file contents' },
      { id: 'file-write', name: 'File Write', description: 'Write files' },
      { id: 'glob', name: 'Glob', description: 'Find files by pattern' },
      { id: 'grep', name: 'Grep', description: 'Search file contents' },
      { id: 'web-search', name: 'Web Search', description: 'Search the internet' },
    ],
  },
]

type ToolCategorySectionProps = {
  category: ToolCategory
  defaultExpanded?: boolean
  onToggle: (toolId: string, enabled: boolean) => void
  tools: Record<string, boolean>
}

export const ToolCategorySection = ({
  category,
  defaultExpanded = true,
  onToggle,
  tools,
}: ToolCategorySectionProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const enabledCount = category.tools.filter((t) => tools[t.id]).length

  return (
    <div className="rounded-lg border border-[color:var(--sep)]">
      <button
        className={[
          'flex w-full items-center justify-between px-3 py-2.5',
          'text-left transition-colors hover:bg-white/5',
        ].join(' ')}
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        <div className="flex items-center gap-2">
          <svg
            className={[
              'h-3.5 w-3.5 text-[color:var(--tx3)] transition-transform',
              expanded ? 'rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-medium text-white">{category.name}</span>
        </div>
        <span className="text-xs text-[color:var(--tx3)]">
          {enabledCount}/{category.tools.length}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[color:var(--sep)] px-3 py-1.5">
          {category.tools.map((tool) => (
            <label
              className={[
                'flex cursor-pointer items-center gap-3 rounded-md px-1 py-2',
                'transition-colors hover:bg-white/5',
              ].join(' ')}
              key={tool.id}
            >
              <input
                checked={tools[tool.id] ?? false}
                className="accent-[#7c3aed]"
                onChange={(e) => onToggle(tool.id, e.target.checked)}
                type="checkbox"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white">{tool.name}</div>
                <div className="text-xs text-[color:var(--tx3)]">{tool.description}</div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
