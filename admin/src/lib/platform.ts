// Which key this machine calls "the command key", read once.
//
// A keyboard shortcut printed in a menu is the only place the admin has ever
// needed to know the platform: ⌘I on a Mac, Ctrl+I everywhere else. Every
// handler keeps accepting *either* modifier (`event.metaKey || event.ctrlKey`,
// the way the comment composer's Cmd/Ctrl+Enter already does) — this decides
// what the label *says*, never what a key handler accepts, so a Windows
// keyboard plugged into a Mac still works.
//
// The probe is a hint, not a fact: `navigator.userAgentData.platform` is the
// modern spelling, `navigator.platform` the deprecated one every browser still
// answers, and the user-agent string the last resort. It is read once and
// cached, because nothing about it changes while the tab is open.

type PlatformNavigator = Navigator & {
  userAgentData?: { platform?: string }
}

const readPlatformHint = (): string => {
  if (typeof navigator === 'undefined') return ''
  const agent = navigator as PlatformNavigator
  return agent.userAgentData?.platform || agent.platform || agent.userAgent || ''
}

let applePlatform: boolean | null = null

/** True on macOS, iPadOS and iOS — the platforms whose primary modifier is ⌘. */
export const isApplePlatform = (): boolean => {
  if (applePlatform === null) {
    applePlatform = /mac|iphone|ipad|ipod/i.test(readPlatformHint())
  }
  return applePlatform
}

/**
 * Drops the memoised probe so the next read runs again.
 *
 * For tests only, and for the same reason `__resetViewportStore` exists: the
 * admin's suite shares one process, so the first file to read the platform
 * would otherwise decide it for every later file.
 */
export const __resetPlatform = (): void => {
  applePlatform = null
}

// The one token table. `Mod` is the platform's primary modifier — the key a
// shortcut means when it says "Cmd/Ctrl".
const APPLE_KEYS: Record<string, string> = {
  Alt: '⌥',
  Ctrl: '⌃',
  Mod: '⌘',
  Shift: '⇧',
}

const OTHER_KEYS: Record<string, string> = {
  Alt: 'Alt',
  Ctrl: 'Ctrl',
  Mod: 'Ctrl',
  Shift: 'Shift',
}

/**
 * The printable form of a shortcut written in the platform-neutral spelling:
 * `Mod+I` → `⌘I` on a Mac and `Ctrl+I` elsewhere, `Mod+Shift+S` → `⌘⇧S` /
 * `Ctrl+Shift+S`, and a bare key (`F2`) is itself on both.
 *
 * Apple's convention joins the glyphs with nothing; everywhere else the parts
 * are joined with `+`, which is what those platforms print.
 */
export const shortcutLabel = (shortcut: string): string => {
  const apple = isApplePlatform()
  const table = apple ? APPLE_KEYS : OTHER_KEYS
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => table[part] ?? part)
  return parts.join(apple ? '' : '+')
}

/**
 * Whether an event carries the platform's primary modifier. Both keys are
 * accepted on every platform on purpose: an external keyboard, a remote
 * desktop session and a Windows VM on a Mac all send the "wrong" one.
 */
export const isPrimaryModifier = (event: {
  ctrlKey: boolean
  metaKey: boolean
}): boolean => event.metaKey || event.ctrlKey
