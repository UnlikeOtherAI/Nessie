/**
 * The one doorway to a trigger's recovery controls.
 *
 * A trigger is its own screen, so this is a route rather than the list's
 * selection query it used to be. Links from the bell, workflows and agent
 * panels therefore all arrive at the same screen and survive a cold reload.
 * The list still forwards the old `?trigger=` address to it.
 */
export const triggerUrl = (triggerId: string): string =>
  `/agents/triggers/${encodeURIComponent(triggerId)}`
