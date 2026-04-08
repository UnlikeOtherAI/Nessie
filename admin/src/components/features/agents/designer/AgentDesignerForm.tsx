import { useAgentCategories } from '../../../../facades/agent-categories/hooks'
import type { AgentDesignerActions, AgentFormState } from './useAgentDesigner'
import { TOOL_CATEGORIES, ToolCategorySection } from './ToolCategorySection'

type AgentDesignerFormProps = {
  actions: AgentDesignerActions
  state: AgentFormState
}

const PROVIDERS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'MiniMax', value: 'minimax' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'Custom', value: 'custom' },
]

type ModelGroup = { label: string; models: { label: string; value: string }[] }

const OPENAI_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'GPT-5 Series',
    models: [
      { value: 'gpt-5', label: 'gpt-5' },
      { value: 'gpt-5-mini', label: 'gpt-5-mini' },
      { value: 'gpt-5-nano', label: 'gpt-5-nano' },
    ],
  },
  {
    label: 'GPT-4.1 Series',
    models: [
      { value: 'gpt-4.1', label: 'gpt-4.1' },
      { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { value: 'gpt-4.1-nano', label: 'gpt-4.1-nano' },
    ],
  },
  {
    label: 'GPT-4o Series',
    models: [
      { value: 'gpt-4o', label: 'gpt-4o' },
      { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ],
  },
  {
    label: 'Reasoning (o-series)',
    models: [
      { value: 'o4-mini', label: 'o4-mini' },
      { value: 'o3', label: 'o3' },
      { value: 'o3-pro', label: 'o3-pro' },
      { value: 'o3-mini', label: 'o3-mini' },
      { value: 'o1', label: 'o1' },
    ],
  },
]

const ANTHROPIC_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'Claude 4',
    models: [
      { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
      { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    ],
  },
  {
    label: 'Claude 3.5 / 3.7',
    models: [
      { value: 'claude-3-7-sonnet-20250219', label: 'claude-3-7-sonnet' },
      { value: 'claude-3-5-sonnet-20241022', label: 'claude-3-5-sonnet' },
      { value: 'claude-3-5-haiku-20241022', label: 'claude-3-5-haiku' },
    ],
  },
]

const fieldLabelClass = [
  'text-xs font-semibold uppercase',
  'tracking-[0.16em] text-[color:var(--tx3)]',
].join(' ')

export const AgentDesignerForm = ({ actions, state }: AgentDesignerFormProps) => {
  const { data: categories = [] } = useAgentCategories()
  const isStreaming = (field: string) => state.streamingField === field

  return (
    <div className="grid gap-5">
      {/* Name */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-name">
          Name
        </label>
        <input
          autoComplete="off"
          className={[
            'admin-input',
            isStreaming('name') ? 'border-[#7c3aed] shadow-[0_0_0_1px_rgba(124,58,237,0.3)]' : '',
          ].join(' ')}
          id="agent-name"
          onChange={(e) => actions.setName(e.target.value)}
          placeholder="e.g. Code Reviewer"
          value={state.name}
        />
      </div>

      {/* Role */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-role">
          Role
        </label>
        <input
          autoComplete="off"
          className={[
            'admin-input',
            isStreaming('role') ? 'border-[#7c3aed] shadow-[0_0_0_1px_rgba(124,58,237,0.3)]' : '',
          ].join(' ')}
          id="agent-role"
          onChange={(e) => actions.setRole(e.target.value)}
          placeholder="e.g. assistant, reviewer, analyst"
          value={state.role}
        />
      </div>

      {/* Category */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-category">
          Category
        </label>
        <select
          className="admin-input"
          id="agent-category"
          onChange={(e) => actions.setCategoryId(e.target.value || null)}
          value={state.categoryId ?? ''}
        >
          <option value="">None</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </div>

      {/* Provider & Model */}
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="agent-provider">
            Provider
          </label>
          <select
            className="admin-input"
            id="agent-provider"
            onChange={(e) => actions.setProvider(e.target.value)}
            value={state.provider}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="agent-model">
            Model
          </label>
          {state.provider === 'openai' || state.provider === 'anthropic' ? (
            <select
              className={[
                'admin-input',
                isStreaming('model')
                  ? 'border-[#7c3aed] shadow-[0_0_0_1px_rgba(124,58,237,0.3)]'
                  : '',
              ].join(' ')}
              id="agent-model"
              onChange={(e) => actions.setModel(e.target.value)}
              value={state.model}
            >
              {(state.provider === 'openai' ? OPENAI_MODEL_GROUPS : ANTHROPIC_MODEL_GROUPS).map(
                (group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          ) : (
            <input
              autoComplete="off"
              className={[
                'admin-input',
                isStreaming('model')
                  ? 'border-[#7c3aed] shadow-[0_0_0_1px_rgba(124,58,237,0.3)]'
                  : '',
              ].join(' ')}
              id="agent-model"
              onChange={(e) => actions.setModel(e.target.value)}
              placeholder="e.g. llama3.2"
              value={state.model}
            />
          )}
        </div>
      </div>

      {/* System prompt */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-system-prompt">
          System prompt
        </label>
        <textarea
          autoComplete="off"
          className={[
            'admin-input resize-none font-mono text-xs leading-relaxed',
            isStreaming('systemPrompt')
              ? 'border-[#7c3aed] shadow-[0_0_0_1px_rgba(124,58,237,0.3)]'
              : '',
          ].join(' ')}
          id="agent-system-prompt"
          onChange={(e) => actions.setSystemPrompt(e.target.value)}
          placeholder="Instructions for the agent..."
          rows={12}
          value={state.systemPrompt}
        />
      </div>

      {/* Tools */}
      <div className="grid gap-1.5">
        <div className={fieldLabelClass}>Tools</div>
        <div className="grid gap-2">
          {TOOL_CATEGORIES.map((cat, i) => (
            <ToolCategorySection
              category={cat}
              defaultExpanded={i === 0}
              key={cat.id}
              onToggle={actions.toggleTool}
              tools={state.tools}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
