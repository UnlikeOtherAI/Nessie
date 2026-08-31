import { useState } from 'react'
import type { AgentTodoTemplateRecord, AgentTodoTemplateStepInput } from '@nessie/schemas'
import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_INSTRUCTIONS_MAX,
  AGENT_TODO_STEP_TITLE_MAX,
  AGENT_TODO_TEMPLATE_DESCRIPTION_MAX,
  AGENT_TODO_TEMPLATE_NAME_MAX,
} from '@nessie/schemas'

type TodoTemplateEditorProps = {
  onCancel: () => void
  onSave: (input: {
    description: string | null
    name: string
    steps: AgentTodoTemplateStepInput[]
  }) => Promise<void>
  saving: boolean
  template?: AgentTodoTemplateRecord
}

const blankStep = (): AgentTodoTemplateStepInput => ({ instructions: '', title: '' })

const templateSteps = (template?: AgentTodoTemplateRecord): AgentTodoTemplateStepInput[] =>
  template?.steps.map((step) => ({ ...step })) ?? [blankStep()]

export const TodoTemplateEditor = ({
  onCancel,
  onSave,
  saving,
  template,
}: TodoTemplateEditorProps) => {
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [steps, setSteps] = useState<AgentTodoTemplateStepInput[]>(() => templateSteps(template))

  const setStep = (
    index: number,
    field: 'instructions' | 'title',
    value: string,
  ) => {
    setSteps((current) => current.map((step, stepIndex) =>
      stepIndex === index ? { ...step, [field]: value } : step,
    ))
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((current) => {
      const destination = index + direction
      if (destination < 0 || destination >= current.length) return current
      const reordered = [...current]
      const [step] = reordered.splice(index, 1)
      if (!step) return current
      reordered.splice(destination, 0, step)
      return reordered
    })
  }

  const removeStep = (index: number) => {
    setSteps((current) => current.length === 1 ? current : current.filter((_, i) => i !== index))
  }

  const save = () => {
    void onSave({
      description: description.trim() || null,
      name: name.trim(),
      steps,
    })
  }

  return (
    <form
      className="grid gap-4 rounded-xl border border-[color:var(--accent)] bg-[color:var(--panel)] p-4"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[color:var(--tx)]">
          {template ? 'Edit template' : 'New template'}
        </h3>
        <span className="text-xs text-[color:var(--tx3)]">
          {steps.length} / {AGENT_TODO_MAX_STEPS} steps
        </span>
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]" htmlFor="todo-template-name">
          Name
        </label>
        <input
          className="admin-input"
          id="todo-template-name"
          maxLength={AGENT_TODO_TEMPLATE_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <span className="text-right text-xs text-[color:var(--tx3)]">
          {name.length} / {AGENT_TODO_TEMPLATE_NAME_MAX}
        </span>
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]" htmlFor="todo-template-description">
          Description
        </label>
        <textarea
          className="admin-input admin-input-compact resize-y"
          id="todo-template-description"
          maxLength={AGENT_TODO_TEMPLATE_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          value={description}
        />
        <span className="text-right text-xs text-[color:var(--tx3)]">
          {description.length} / {AGENT_TODO_TEMPLATE_DESCRIPTION_MAX}
        </span>
      </div>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            Ordered steps
          </div>
          <button
            className="admin-button admin-button-secondary"
            disabled={steps.length >= AGENT_TODO_MAX_STEPS}
            onClick={() => setSteps((current) => [...current, blankStep()])}
            type="button"
          >
            Add step
          </button>
        </div>

        {steps.map((step, index) => (
          <fieldset
            className="grid gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3"
            key={step.key ?? `${index}-${step.title}`}
          >
            <legend className="px-1 text-xs font-semibold text-[color:var(--tx2)]">
              Step {index + 1}
            </legend>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                aria-label={`Move step ${index + 1} up`}
                className="admin-button admin-button-secondary"
                disabled={index === 0}
                onClick={() => moveStep(index, -1)}
                type="button"
              >
                Move up
              </button>
              <button
                aria-label={`Move step ${index + 1} down`}
                className="admin-button admin-button-secondary"
                disabled={index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
                type="button"
              >
                Move down
              </button>
              <button
                className="admin-button admin-button-danger"
                disabled={steps.length === 1}
                onClick={() => removeStep(index)}
                type="button"
              >
                Remove
              </button>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-[color:var(--tx2)]" htmlFor={`todo-step-title-${index}`}>
                Title
              </label>
              <input
                className="admin-input"
                id={`todo-step-title-${index}`}
                maxLength={AGENT_TODO_STEP_TITLE_MAX}
                onChange={(event) => setStep(index, 'title', event.target.value)}
                required
                value={step.title}
              />
              <span className="text-right text-xs text-[color:var(--tx3)]">
                {step.title.length} / {AGENT_TODO_STEP_TITLE_MAX}
              </span>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-[color:var(--tx2)]" htmlFor={`todo-step-instructions-${index}`}>
                Instructions
              </label>
              <textarea
                className="admin-input admin-input-compact resize-y"
                id={`todo-step-instructions-${index}`}
                maxLength={AGENT_TODO_STEP_INSTRUCTIONS_MAX}
                onChange={(event) => setStep(index, 'instructions', event.target.value)}
                required
                rows={4}
                value={step.instructions}
              />
              <span className="text-right text-xs text-[color:var(--tx3)]">
                {step.instructions.length} / {AGENT_TODO_STEP_INSTRUCTIONS_MAX}
              </span>
            </div>
          </fieldset>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <button className="admin-button admin-button-secondary" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="admin-button admin-button-primary" disabled={saving} type="submit">
          {saving ? 'Saving…' : template ? 'Save template' : 'Create template'}
        </button>
      </div>
    </form>
  )
}
