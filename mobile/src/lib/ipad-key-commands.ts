import { TABS, type TabKey } from './tabs'

/**
 * Hardware-keyboard commands for the iPad, with a Magic Keyboard attached.
 *
 * An iPad without keyboard shortcuts does not feel like an iPad app — holding ⌘
 * on any first-class iPadOS app raises a discoverability overlay listing what
 * the keyboard can do, and Nessie had nothing. This module is the single source
 * of truth for that command set.
 *
 * **All of the semantics live here, in tested TypeScript.** The native module
 * (`modules/nessie-key-commands`) is a dumb registrar: it is handed the table
 * `serializeIpadKeyCommandsForNative()` produces — an id, the key, a raw
 * `UIKeyModifierFlags` bitmask, and the title iPadOS shows in the ⌘ overlay —
 * builds one `UIKeyCommand` per row, and posts the row's `id` back when it
 * fires. It knows nothing about tabs, search, or navigation, so the mapping
 * from a chord to an action never has to be reasoned about in Swift.
 */

// The modifiers a command requires, named rather than encoded so the table
// below reads as intent. `command` is ⌘, `shift` ⇧, `control` ⌃, `alternate` ⌥.
export type KeyCommandModifier = 'command' | 'shift' | 'control' | 'alternate'

// The raw values of `UIKeyModifierFlags` (UIKit). Kept here, beside the only
// code that produces the bitmask, so the native side declares no constants of
// its own and the two cannot drift.
const UI_KEY_MODIFIER_FLAG: Record<KeyCommandModifier, number> = {
  alternate: 1 << 19, // 524288
  command: 1 << 20, // 1048576
  control: 1 << 18, // 262144
  shift: 1 << 17, // 131072
}

/**
 * What a fired command does, as data. Resolving a chord to one of these is pure
 * and tested; performing it (calling into the WebView bridge, changing the tab)
 * is the shell's job, wired through `applyIpadKeyCommandAction`.
 */
export type IpadKeyCommandAction =
  // Jump straight to a top-level destination (⌘1–⌘4).
  | { readonly kind: 'select-tab'; readonly tabKey: TabKey }
  // Move one destination left or right, wrapping (⌃⇥ / ⌃⇧⇥).
  | { readonly kind: 'cycle-tab'; readonly delta: 1 | -1 }
  // Open the search overlay (⌘K), the same surface the Search tab opens on iPad.
  | { readonly kind: 'search' }
  // Open the creation menu (⌘N) — new channel, agent, and so on.
  | { readonly kind: 'create' }
  // The toolbar's own history controls (⌘[ / ⌘]).
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  // Reload the WebView (⌘R), the keyboard twin of the sidebar's Full refresh.
  | { readonly kind: 'refresh' }

export type IpadKeyCommandId =
  | 'tab-channels'
  | 'tab-projects'
  | 'tab-knowledge'
  | 'tab-admin'
  | 'search'
  | 'create'
  | 'back'
  | 'forward'
  | 'next-tab'
  | 'prev-tab'
  | 'refresh'

export type IpadKeyCommandDef = {
  readonly id: IpadKeyCommandId
  // The character, as UIKit expects it in `UIKeyCommand(input:)`. Letters are
  // lowercase; a ⌘⇧ chord is expressed by adding `shift`, never by uppercasing.
  readonly input: string
  readonly modifiers: readonly KeyCommandModifier[]
  // Shown verbatim in the hold-⌘ discoverability overlay, so it is user copy.
  readonly title: string
  readonly action: IpadKeyCommandAction
}

// `\t` is the Tab key. `input` values map 1:1 to `UIKeyCommand` inputs; the
// arrow/tab constants would be `UIKeyInputLeftArrow` etc., but the commands
// here need only printable keys plus Tab.
const TAB_INPUT = '\t'

/**
 * The command set. Ordered as it should read in the ⌘ overlay: destinations
 * first, then the actions, then navigation.
 *
 * ⌘1–⌘4 cover the four destinations that own a screen; Search is ⌘K rather than
 * ⌘5 because on iPad it is an overlay, not a place — matching how the Search tab
 * behaves (`applyNativeTabIndexChange`).
 */
export const IPAD_KEY_COMMANDS: readonly IpadKeyCommandDef[] = [
  { id: 'tab-channels', input: '1', modifiers: ['command'], title: 'Channels', action: { kind: 'select-tab', tabKey: 'channels' } },
  { id: 'tab-projects', input: '2', modifiers: ['command'], title: 'Projects', action: { kind: 'select-tab', tabKey: 'projects' } },
  { id: 'tab-knowledge', input: '3', modifiers: ['command'], title: 'Knowledge', action: { kind: 'select-tab', tabKey: 'knowledge' } },
  { id: 'tab-admin', input: '4', modifiers: ['command'], title: 'Admin', action: { kind: 'select-tab', tabKey: 'admin' } },
  { id: 'search', input: 'k', modifiers: ['command'], title: 'Search', action: { kind: 'search' } },
  { id: 'create', input: 'n', modifiers: ['command'], title: 'New…', action: { kind: 'create' } },
  { id: 'back', input: '[', modifiers: ['command'], title: 'Back', action: { kind: 'back' } },
  { id: 'forward', input: ']', modifiers: ['command'], title: 'Forward', action: { kind: 'forward' } },
  { id: 'next-tab', input: TAB_INPUT, modifiers: ['control'], title: 'Next section', action: { kind: 'cycle-tab', delta: 1 } },
  { id: 'prev-tab', input: TAB_INPUT, modifiers: ['control', 'shift'], title: 'Previous section', action: { kind: 'cycle-tab', delta: -1 } },
  { id: 'refresh', input: 'r', modifiers: ['command'], title: 'Reload', action: { kind: 'refresh' } },
]

const COMMANDS_BY_ID: ReadonlyMap<IpadKeyCommandId, IpadKeyCommandDef> = new Map(
  IPAD_KEY_COMMANDS.map((command) => [command.id, command]),
)

/** OR the named modifiers into a `UIKeyModifierFlags` bitmask. */
export const keyCommandModifierBitmask = (modifiers: readonly KeyCommandModifier[]): number =>
  modifiers.reduce((mask, modifier) => mask | UI_KEY_MODIFIER_FLAG[modifier], 0)

export type NativeKeyCommand = {
  readonly id: IpadKeyCommandId
  readonly input: string
  readonly modifierFlags: number
  readonly title: string
}

/**
 * The table handed to the native registrar. Deliberately flat and free of any
 * action semantics: everything the Swift side needs is the key, the bitmask,
 * the overlay title, and the id to echo back.
 */
export const serializeIpadKeyCommandsForNative = (): NativeKeyCommand[] =>
  IPAD_KEY_COMMANDS.map((command) => ({
    id: command.id,
    input: command.input,
    modifierFlags: keyCommandModifierBitmask(command.modifiers),
    title: command.title,
  }))

/**
 * The action a fired command id maps to, or null for an id this build does not
 * know — an installed shell must ignore a command from a future table rather
 * than crash.
 */
export const resolveIpadKeyCommandAction = (id: string): IpadKeyCommandAction | null =>
  COMMANDS_BY_ID.get(id as IpadKeyCommandId)?.action ?? null

// The tab keys a ⌘-number or cycle can land on, in bar order. Search is absent:
// it is an overlay reached by ⌘K, never a destination you cycle onto.
const CYCLEABLE_TAB_KEYS: readonly TabKey[] = TABS
  .map((tab) => tab.key)
  .filter((key): key is TabKey => key !== 'search')

export type IpadKeyCommandHandlers = {
  // Drive the shell to a destination by its bar index — the same entry point a
  // tab tap uses, so selection, list-column and menu-dismissal stay identical.
  readonly selectTabIndex: (index: number) => void
  readonly openSearch: () => void
  readonly openCreationMenu: () => void
  readonly goBack: () => void
  readonly goForward: () => void
  readonly reload: () => void
}

/**
 * Perform a resolved action. Pure but for the handler calls, so a test can
 * assert exactly which handler a chord reaches and with what index; the wrap
 * arithmetic for cycling lives here rather than in the shell.
 *
 * `activeIndex` is the currently selected bar index, needed only to cycle.
 */
export const applyIpadKeyCommandAction = (
  action: IpadKeyCommandAction,
  handlers: IpadKeyCommandHandlers,
  context: { readonly activeIndex: number },
): void => {
  switch (action.kind) {
    case 'select-tab': {
      const index = TABS.findIndex((tab) => tab.key === action.tabKey)
      if (index !== -1) handlers.selectTabIndex(index)
      return
    }
    case 'cycle-tab': {
      // Cycle within the cycleable destinations, then translate back to a bar
      // index. Anchoring off the *current* key (not the raw bar index) keeps
      // the wrap correct even though Search sits in the bar but not the cycle.
      const currentKey = TABS[context.activeIndex]?.key
      const from = currentKey ? CYCLEABLE_TAB_KEYS.indexOf(currentKey) : -1
      const anchor = from === -1 ? 0 : from
      const count = CYCLEABLE_TAB_KEYS.length
      const nextKey = CYCLEABLE_TAB_KEYS[(anchor + action.delta + count) % count]
      const barIndex = TABS.findIndex((tab) => tab.key === nextKey)
      if (barIndex !== -1) handlers.selectTabIndex(barIndex)
      return
    }
    case 'search':
      handlers.openSearch()
      return
    case 'create':
      handlers.openCreationMenu()
      return
    case 'back':
      handlers.goBack()
      return
    case 'forward':
      handlers.goForward()
      return
    case 'refresh':
      handlers.reload()
      return
  }
}
