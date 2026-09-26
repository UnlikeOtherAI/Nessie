import type { Surface } from './page-types'
import {
  toConnectedAccounts,
  toSettings,
  toSettingsSecurity,
  toStatus,
} from './surface-parents'

// Your settings: the pages about the person reading them, opened from the
// avatar menu wherever they are standing. They keep the Admin section id —
// the section names are a wire contract with the native shells, and a sixth
// would be a new tab — but their own root, `/settings`: on a phone that root
// is the Your settings list, and on a wider layout it forwards to Profile.
// No rail item lights here (`nav-items.tsx` → `matchesSettingsRoute`).
//
// Every page one step in is `parent: 'origin'`, as `/alerts` is: Back returns
// to where the person came from, and names the Your settings list only on a
// cold deep link, which is also what a cold start seeds beneath it.
export const createSettingsSurfaces = (settingsRoot: string): Surface[] => [
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/settings$/,
    root: settingsRoot,
    section: 'admin',
    type: 'root',
  },
  {
    depth: 1,
    // `tab` is Connected accounts' strip (`mail` · `chat` · `tickets` ·
    // `browsers` · `ai`), `filter` Your computers' Mine · Shared with me,
    // `status` Saved keys' Active · Revoked. `code` is Security's: a program's
    // own verification link carries it, and it opens the pairing dialog on the
    // decision before leaving the address. `connected`, `error` and `provider`
    // are Connected accounts' OAuth return: its notice, on the tab the provider
    // belongs to.
    intent: {
      consume: ['code', 'connected', 'error', 'provider'],
      state: ['tab', 'filter', 'status'],
    },
    parent: 'origin',
    parentOf: toSettings,
    pattern: /^\/settings\/(?:profile|notifications|appearance|status|accounts|computers|keys|usage|security)$/,
    root: settingsRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // Not `splitInline`: a status is its own route component, so a wide
    // layout pushes it like every other detail screen rather than the list
    // page rendering it in a second column of its own.
    depth: 2,
    identityOf: (match) => `status:${match[1]}`,
    keyScope: () => 'status',
    parentOf: toStatus,
    pattern: /^\/settings\/status\/([^/]+)$/,
    root: settingsRoot,
    section: 'admin',
    type: 'nested',
  },
  {
    // One connected account, pushed from its tab of Connected accounts; a
    // warm Back pops to that tab, and a cold link falls back to the page.
    depth: 2,
    identityOf: (match) => `connection:${match[1]}`,
    keyScope: () => 'connection',
    parentOf: toConnectedAccounts,
    pattern: /^\/settings\/accounts\/([^/]+)$/,
    root: settingsRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // One program signed in as you, pushed from Security.
    depth: 2,
    identityOf: (match) => `paired-agent:${match[1]}`,
    keyScope: () => 'paired-agent',
    parentOf: toSettingsSecurity,
    pattern: /^\/settings\/security\/programs\/([^/]+)$/,
    root: settingsRoot,
    section: 'admin',
    type: 'detail',
  },
]
