import type { NativeScreenBarAction } from './native-shell-layout'

/**
 * How the screen's actions are split between the bar and its overflow sheet.
 *
 * Text-first, the way a UIKit bar is: the screen's primary action is the only
 * one that earns a place in the bar, and everything else goes into a sheet
 * that lists actions by their label. That is deliberately not a miniature of
 * the web header's responsive partition — it avoids an icon vocabulary
 * maintained in two repositories, which is the part most likely to rot, and it
 * means an action can never be dropped for want of an icon.
 *
 * Order in the sheet follows the web's own sense of importance: the header
 * sheds its *lowest* priority actions to overflow first, so the highest
 * priority reads first here too. A disabled action still appears — a control
 * that vanishes when it cannot be used is a control nobody can find.
 */
export type NativeScreenBarPartition = {
  overflow: NativeScreenBarAction[]
  primary: NativeScreenBarAction | null
}

export const partitionNativeScreenBarActions = (
  actions: readonly NativeScreenBarAction[],
): NativeScreenBarPartition => {
  const primary = actions.find((action) => action.primary && !action.disabled) ?? null
  const overflow = actions
    .filter((action) => action !== primary)
    .slice()
    .sort((left, right) => right.priority - left.priority)
  return { overflow, primary }
}

/**
 * The sheet's rows for one action list, plus the trailing Cancel every iOS
 * action sheet carries. A menu is one row that opens a second sheet rather
 * than being flattened into this one, so a reader never has to guess which
 * group a row came from.
 */
export const nativeScreenBarSheetLabels = (
  actions: readonly NativeScreenBarAction[],
): string[] => [
  ...actions.map((action) => (
    // A checked toggle and a selected action are both "this is on right now"
    // — a live call, an open search, a recording routine. A sheet row that
    // read the same either way would be lying about what the screen is doing.
    (action.kind === 'toggle' && action.checked) || action.selected
      ? `✓ ${action.label}`
      : action.label
  )),
  'Cancel',
]

export const nativeScreenBarDisabledIndices = (
  actions: readonly NativeScreenBarAction[],
): number[] => actions
  .map((action, index) => (action.disabled ? index : -1))
  .filter((index) => index !== -1)
