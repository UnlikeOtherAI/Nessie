import { TOOL_CATEGORIES } from './designer/ToolCategorySection'
import { EmptyState } from '../../shared/EmptyState'

export const AgentAvailableTools = () => (
  <div className="grid gap-6">
    {TOOL_CATEGORIES.length === 0 ? (
      <EmptyState>No tools configured.</EmptyState>
    ) : (
      TOOL_CATEGORIES.map((category) => (
        <section key={category.id} className="grid gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
            {category.name}
          </div>
          <div className="grid gap-2">
            {category.tools.map((tool) => (
              <div
                key={tool.id}
                className="rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-4"
              >
                <div className="font-mono text-sm text-[var(--thinking)]">{tool.name}</div>
                <div className="mt-1 text-xs text-[color:var(--tx3)]">{tool.description}</div>
              </div>
            ))}
          </div>
        </section>
      ))
    )}
  </div>
)
