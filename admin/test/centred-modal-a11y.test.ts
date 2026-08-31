import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The centred-modal rule, enforced instead of documented.
 *
 * `components/shared/Dialog.tsx` exists because roughly half the admin's centred
 * modals shipped with no Escape, no focus trap, no focus restore and no
 * `role="dialog"`. Prose did not hold: `EditProjectDialog` landed *after* the
 * shell, hand-rolling the same scrim with none of those affordances — the exact
 * defect the shell was built to end, re-introduced by product work in parallel.
 *
 * So this walks `src` and holds every centred modal to one rule: it composes the
 * shell, or it composes `useModalA11y` itself, or it is named below with a
 * reason. The list is exact in both directions — a new unconverted modal fails,
 * and an entry that no longer needs to be one fails too.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const SHELL = resolve(SRC, 'components/shared/Dialog.tsx')
const A11Y_HOOK = resolve(SRC, 'components/shared/useModalA11y.ts')

/**
 * Centred modals that compose neither the shell nor the hook. Two kinds of
 * entry, and neither is an endorsement of the missing keyboard affordances:
 *
 *  - a documented refusal to wear the shell's chrome (the comment is in the
 *    file). That refusal is about the panel, not about Escape — such a file
 *    should still reach for `useModalA11y`, and this entry is what makes that
 *    debt countable rather than invisible;
 *  - plainly unconverted debt, with no comment in the file at all.
 *
 * Nothing may be added here to make a *new* modal pass. The shell is the
 * default; a genuine outlier keeps its markup AND composes `useModalA11y`, at
 * which point it does not belong on this list.
 */
const WITHOUT_SHELL_OR_HOOK: Record<string, string> = {
  'src/components/features/knowledge/FileVersionUploadDialog.tsx':
    'Documented in file: a rounded-2xl / --main / p-5 card with a drop shadow and a text "Close" '
    + 'control, none of which the shell\'s .create-channel-panel chrome expresses.',
  'src/components/features/mcp-app-store/CredentialsDialog.tsx':
    'Documented in file: the app-store modals are admin-card panels on --main with a ghost "Close" '
    + 'control, not the shell\'s .create-channel-panel card and close cross.',
  'src/components/features/mcp-app-store/InstallScopeDialog.tsx':
    'Documented in file: an admin-card panel that *is* the <form>, with no close control at all — '
    + 'the shell always renders one.',
  'src/components/features/mcp-app-store/LibraryInstallDialog.tsx':
    'Documented in file: an admin-card panel that *is* the <form>, with no close control at all — '
    + 'the shell always renders one.',
  'src/components/features/mcp-app-store/RejectDialog.tsx':
    'Documented in file: an admin-card panel with no close control and no scrim dismissal — '
    + 'rejecting needs a deliberate Cancel, not a stray click.',
  'src/components/features/triggers/TriggerEditorDialog.tsx':
    'Documented in file: its subtitle is mt-1 text-sm where the shell renders a description at '
    + 'text-xs, and its 680px panel is not one of the three geometries the shell ships.',
  'src/pages/McpAppStorePage.tsx':
    'Unconverted debt, no reason recorded in the file: the inline "Add MCP server" wizard modal, an '
    + 'admin-card max-w-2xl on --main in the same family as the app-store dialogs above, with no '
    + 'keyboard affordances at all.',
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

/**
 * The scrim every centred modal paints: `--scrim-strong` as a *background* on a
 * fixed, inset-0, centring box — written either as Tailwind classes or as an
 * inline style object, both of which ship in this codebase. Matched in a window
 * around the scrim colour rather than on one line, because the classes are
 * routinely split across a `[...].join(' ')` array.
 *
 * Deliberately narrow: edge-anchored drawers and popovers use the same colour
 * without the centring, and `box-shadow: … var(--scrim-strong)` is decoration on
 * a card. None of those are modals and none of them are matched.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

const paintsCentredScrim = (source: string): boolean => {
  const lines = source.split('\n')
  return lines.some((line, index) => {
    if (!line.includes('--scrim-strong')) return false
    if (/shadow/i.test(line)) return false
    if (!/bg-\[|background:/.test(line)) return false
    const window = lines.slice(Math.max(0, index - 12), index + 13).join('\n')
    // `fixed` and `inset-0` are matched independently, NOT as an adjacent pair:
    // a modal written `fixed z-[9999] inset-0` is the same modal, and requiring
    // adjacency let exactly that slip past.
    const fixedFullBleed = (/\bfixed\b/.test(window) && /\binset-0\b/.test(window))
      || (/position:\s*'fixed'/.test(window) && /inset:\s*0/.test(window))
    const centred = (/items-center/.test(window) && /justify-center/.test(window))
      || (/alignItems:\s*'center'/.test(window) && /justifyContent:\s*'center'/.test(window))
    return fixedFullBleed && centred
  })
}

/** Resolves every relative import in the file to an absolute source path. */
const importTargets = (source: string, file: string): Map<string, string[]> => {
  const targets = new Map<string, string[]>()
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']*)'/g
  for (const match of source.matchAll(pattern)) {
    const names = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0].trim())
    for (const extension of ['.tsx', '.ts']) {
      const resolved = resolve(dirname(file), `${match[2]}${extension}`)
      targets.set(resolved, [...(targets.get(resolved) ?? []), ...names])
    }
  }
  return targets
}

type Modal = {
  composesA11yHook: boolean
  file: string
  importsShell: boolean
  paintsScrim: boolean
  path: string
}

const modals: Modal[] = []
for (const path of walk(SRC).filter((file) => file.endsWith('.tsx'))) {
  // Comments describe modals as often as they build them — a maintainer note
  // quoting the scrim CSS is not a modal. Strip block and line comments before
  // detecting, which the query-key guard deliberately does NOT do (there a
  // trailing `//` can hide a real literal behind a `https://` inside a string).
  const source = stripComments(readFileSync(path, 'utf8'))
  const imports = importTargets(source, path)
  const importsShell = (imports.get(SHELL) ?? []).includes('Dialog')
  // A file that renders the shell is a centred modal too — that is the whole
  // point of converting one. Without this the rule would only ever look at
  // dialogs that had *not* been converted, and stripping the shell import back
  // out of a converted one would go unnoticed.
  const rendersShell = /<Dialog[\s/>]/.test(source)
  const paintsScrim = paintsCentredScrim(source)
  if (!paintsScrim && !rendersShell) continue
  modals.push({
    composesA11yHook: (imports.get(A11Y_HOOK) ?? []).includes('useModalA11y'),
    file: relative(SRC, path),
    importsShell,
    paintsScrim,
    path: `src/${relative(SRC, path)}`,
  })
}

const guarded = (modal: Modal) => modal.importsShell || modal.composesA11yHook

test('the scan finds the admin\'s centred modals at all', () => {
  // A detector that silently matches nothing would make every assertion below
  // vacuous, which is how this class of test rots.
  assert.ok(modals.length >= 20, `expected the admin's centred modals, found ${modals.length}`)
  assert.ok(
    modals.some((modal) => modal.path === 'src/components/shared/Dialog.tsx'),
    'the shell itself paints the scrim and must be in the scanned set',
  )
  assert.ok(
    modals.some((modal) => modal.path === 'src/components/shared/EditProjectDialog.tsx'),
    'EditProjectDialog is a centred modal and must be in the scanned set',
  )
})

test('every centred modal composes the shell or useModalA11y', () => {
  const offenders = modals
    .filter((modal) => !guarded(modal) && !(modal.path in WITHOUT_SHELL_OR_HOOK))
    .map((modal) => modal.path)
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')}: a centred modal with no Escape, no focus trap, no focus restore and `
    + 'no role="dialog". Compose components/shared/Dialog, or useModalA11y if the shell cannot '
    + 'reproduce the panel — and say which property it cannot express.',
  )
})

test('a modal that renders the shell imports it from the shell', () => {
  // Catches the half-conversion: `<Dialog>` in the markup with the import gone,
  // or pointed at a local look-alike.
  const offenders = modals
    .filter((modal) => !modal.paintsScrim && !modal.importsShell)
    .map((modal) => modal.path)
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')}: renders <Dialog> without importing components/shared/Dialog.`,
  )
})

test('no exception has stopped needing to be one', () => {
  for (const [path, reason] of Object.entries(WITHOUT_SHELL_OR_HOOK)) {
    const modal = modals.find((candidate) => candidate.path === path)
    assert.ok(
      modal,
      `${path}: listed as a centred modal that composes neither, but it no longer paints a centred `
      + 'scrim. Delete the entry.',
    )
    assert.ok(
      !guarded(modal),
      `${path}: now composes the shell or useModalA11y. Delete the entry.`,
    )
    assert.ok(
      reason.length >= 40,
      `${path}: an exception carries a reason naming what the shell cannot express.`,
    )
  }
})
