import type { AgentConfigForm } from './useAgentConfigForm'

type AgentSaveBarProps = {
  form: AgentConfigForm
  onSave: () => void
}

/**
 * The one Save for an agent's Instructions and Settings, which are one form:
 * a change on either tab is saved from either. It says what is waiting, what
 * blocks a save, and what the server refused — a disabled button on its own
 * explains nothing, and a failed save used to vanish without a word.
 */
export const AgentSaveBar = ({ form, onSave }: AgentSaveBarProps) => {
  const note = form.saveError
    ?? (form.isDirty ? form.blocker ?? 'Unsaved changes on Instructions or Settings.' : 'All changes saved.')
  return (
    <div
      className={[
        'flex flex-shrink-0 flex-wrap items-center justify-between gap-3',
        'border-b border-[color:var(--sep)] px-[var(--page-gutter)] py-2.5',
      ].join(' ')}
      data-testid="agent-save-bar"
    >
      <p
        className={form.saveError
          ? 'text-xs text-[color:var(--danger-text)]'
          : 'text-xs text-[color:var(--tx3)]'}
        role={form.saveError ? 'alert' : 'status'}
      >
        {note}
      </p>
      <button
        className="admin-button admin-button-primary"
        disabled={!form.canSave}
        onClick={onSave}
        type="button"
      >
        {form.isSaving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}
