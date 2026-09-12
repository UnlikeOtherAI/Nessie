/**
 * The one doorway to a trigger's recovery controls.
 *
 * `useTriggersPageState` consumes this anchor through the navigation intent
 * framework, selecting the trigger and removing the one-shot fragment. Links
 * from the bell, workflows, and agent panels therefore all arrive at the same
 * exact control rather than each inventing a fragment shape.
 */
export const triggerUrl = (triggerId: string): string =>
  `/agents/triggers#trigger-${encodeURIComponent(triggerId)}`
