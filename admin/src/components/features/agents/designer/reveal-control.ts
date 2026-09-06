const highlightDurationMs = 1_600

/**
 * Every assistant-driven change first reveals the same control a person would
 * use. The animation is feedback, not a second state: callers still invoke
 * the control's existing state/update path afterwards.
 */
export const revealDesignerControl = (id: string): void => {
  const control = document.getElementById(id)
  if (!control) return

  control.scrollIntoView({ behavior: 'smooth', block: 'center' })
  control.classList.remove('designer-control-highlight')
  // Restart the highlight when the assistant makes a second change quickly.
  void control.offsetWidth
  control.classList.add('designer-control-highlight')
  // Fire-once DOM animation with no owner to unmount against: if `control`
  // is gone by the time this fires, classList.remove on a detached node is a
  // harmless no-op, so no clearTimeout/cleanup is needed.
  window.setTimeout(() => control.classList.remove('designer-control-highlight'), highlightDurationMs)

  const focusTarget = control.matches('input, textarea, select, button')
    ? control
    : control.querySelector<HTMLElement>('input, textarea, select, button, [role="switch"]')
  focusTarget?.focus({ preventScroll: true })
}

export const revealDesignerToolCall = (name: string): void => {
  const controlId = {
    set_model: 'agent-model',
    set_name: 'agent-name',
    set_role: 'agent-role',
    set_system_prompt: 'agent-system-prompt',
  }[name]

  if (controlId) revealDesignerControl(controlId)
}
