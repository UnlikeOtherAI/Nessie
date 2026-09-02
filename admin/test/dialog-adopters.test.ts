import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Step 8 of docs/navigation/overview.md §7: the bespoke centred dialogs that used to
 * compose `useModalA11y`/`useOverlayDismiss` directly now go through one of
 * the two sanctioned doorways — the shared `Dialog`/`ConfirmDialog` shell for
 * a panel that fits one of its four geometries, or `useOverlay` directly for
 * a genuine carve-out (its own comment says why it isn't `Dialog`). Either
 * way, none of them may hand-roll a z-index of its own any more — the shared
 * layer scale (`docs/navigation/overview.md` §7) is the only source of one.
 *
 * `EditProjectDialog` landed on the shell in an earlier step; it is pinned
 * here too because it is one of the fourteen files this step named.
 */

const source = (path: string): string =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

// `z-[…]` (Tailwind arbitrary), `zIndex:` (inline style) and a bare `9999`
// that is not a CSS length (`9999px`, the legitimate giant box-shadow trick
// CircleImageCropper's crop mask uses to flood the viewport) are the three
// shapes a hand-rolled z-index takes in this codebase.
const declaresOwnZIndex = (fileSource: string): boolean =>
  /z-\[/.test(fileSource) || /zIndex:/.test(fileSource) || /9999(?!px)/.test(fileSource)

type Adopter = { mode: 'dialog' | 'overlay'; path: string }

const ADOPTERS: Adopter[] = [
  { mode: 'overlay', path: 'components/shared/MemberManagementPopup.tsx' },
  // Renders both: the settings form on `Dialog`, and its archive confirm as
  // the sanctioned nested `ConfirmDialog(blocking)`.
  { mode: 'dialog', path: 'components/shared/ChannelSettingsDialog.tsx' },
  { mode: 'overlay', path: 'components/shared/SessionDebugDialog.tsx' },
  { mode: 'dialog', path: 'components/shared/CircleImageCropper.tsx' },
  { mode: 'dialog', path: 'components/shared/EditProjectDialog.tsx' },
  { mode: 'overlay', path: 'components/shared/AttachmentViewer.tsx' },
  { mode: 'overlay', path: 'components/features/agents/AgentAvatarQuickEdit.tsx' },
  { mode: 'overlay', path: 'components/features/channels/DocumentStreamDialog.tsx' },
  { mode: 'dialog', path: 'components/features/channels/DocumentStreamLeaveConfirm.tsx' },
  { mode: 'overlay', path: 'components/features/channels/ThoughtProcessDialog.tsx' },
  { mode: 'dialog', path: 'components/features/executors/ExecutorRunLauncherDialog.tsx' },
  { mode: 'overlay', path: 'components/features/billing/UoaBillingCancellationDialog.tsx' },
  { mode: 'overlay', path: 'components/features/integrations/DeepWaterResearchLauncherDialog.tsx' },
  { mode: 'overlay', path: 'components/features/triggers/TriggerEditorDialog.tsx' },
  // A Flow, not a modal on `single` (docs/navigation/overview.md §7): still pinned here
  // because it is one of the fourteen files and still must own no z-index.
  { mode: 'overlay', path: 'pages/ChannelConversationComposePage.tsx' },
]

for (const { mode, path } of ADOPTERS) {
  test(`${path} adopts the shared overlay machinery and owns no z-index`, () => {
    const fileSource = source(path)
    if (mode === 'dialog') {
      assert.match(
        fileSource,
        /<Dialog[\s/]|<ConfirmDialog[\s/]/,
        `${path}: expected to render <Dialog> or <ConfirmDialog>`,
      )
    } else {
      assert.match(
        fileSource,
        /useOverlay\(\{/,
        `${path}: expected to call useOverlay(`,
      )
    }
    assert.ok(
      !declaresOwnZIndex(fileSource),
      `${path}: declares its own z-index (z-[…], zIndex:, or a bare 9999) instead of the shared layer scale.`,
    )
  })
}
