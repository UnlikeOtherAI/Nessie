/**
 * The one doorway to a trigger's recovery controls.
 *
 * `useTriggersPageState` reads this registered URL state. Links from the bell,
 * workflows, and agent panels therefore all arrive at the same exact control
 * and preserve it across a cold reload rather than inventing a fragment shape.
 */
export const triggerUrl = (triggerId: string): string =>
  `/agents/triggers?trigger=${encodeURIComponent(triggerId)}`
