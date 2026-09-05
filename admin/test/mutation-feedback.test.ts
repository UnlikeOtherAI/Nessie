import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The mutation-error-feedback ratchet (docs/plans/2026-09-05-admin-architecture-review
 * audit 09-F3).
 *
 * `retry: 0` on mutations means one network blip is one permanently lost user
 * action, and 43 of 144 mutation-bearing components surfaced nothing at all
 * on failure — the checkbox, the toggle, the save just stayed as it was, with
 * no signal that the server refused it. `packages/client-core/src/QueryProvider.tsx`
 * now carries an app-wide `MutationCache.onError` default (wired to a toast
 * in `admin/src/providers/QueryProvider.tsx`), so nothing is silently
 * swallowed any more at runtime — but this walks `src` and holds every call
 * site to its own explicit handling too, the same ratchet idiom as
 * `centred-modal-a11y.test.ts`: a file with `.mutate(`/`.mutateAsync(` reads
 * its own error (`onError`, `catch`, `toFormErrors` or `formErrorMessage`),
 * or it is named below with a reason. The list is exact in both directions —
 * a new unconverted call site fails, and an entry that no longer needs to be
 * one fails too.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

const MUTATE_CALL = /\.mutate(?:Async)?\(/
// Any of the four reads the rejection: an inline `onError`, a `try`/`catch`
// or `.catch(`, or either of the two shared helpers in facades/forms/form-errors.ts.
const READS_ITS_OWN_ERROR = /\bonError\b|\bcatch\b|\btoFormErrors\b|\bformErrorMessage\b/

/**
 * Files that call a mutation with no local `onError`/`catch`/`toFormErrors`/
 * `formErrorMessage` as of 2026-09-05 — computed by this file's own scan
 * (`node --test` re-runs it every time, so the list cannot drift silently).
 * The app-wide toast default still catches every one of these at runtime;
 * this is debt to convert to an explicit surface, not a live bug report.
 */
const REASON = 'Swallowed before the app-wide MutationCache.onError default (audit 09-F3) — '
  + 'not converted by this change. Runtime failures now toast; add onError/catch/'
  + 'toFormErrors/formErrorMessage here, then delete this line.'

const MUTATION_FEEDBACK_ALLOWLIST: Record<string, string> = {
  'components/features/agents/AgentOwnershipState.tsx': REASON,
  'components/features/agents/AgentTriggerPanel.tsx': REASON,
  'components/features/apps/AppConnectionsList.tsx': REASON,
  'components/features/billing/UoaBillingCreditsPanel.tsx': REASON,
  'components/features/billing/UoaBillingRecurringAddonsPanel.tsx': REASON,
  'components/features/channels/AppSetupCard.tsx': REASON,
  'components/features/channels/ConversationInfoFlow.tsx': REASON,
  'components/features/channels/panels/ChannelPersonalAssistantPresences.tsx': REASON,
  'components/features/dashboards/DashboardCanvas.tsx': REASON,
  'components/features/integrations/BuildMeProjectPanel.tsx': REASON,
  'components/features/integrations/DeepTestSecurityPanel.tsx': REASON,
  'components/features/integrations/DeepWaterResearchLauncher.tsx': REASON,
  'components/features/integrations/DeepWaterResearchPanel.tsx': REASON,
  'components/features/integrations/ExternalAgentActivationSection.tsx': REASON,
  'components/features/knowledge/AttachmentsDrawer.tsx': REASON,
  'components/features/knowledge/KnowledgeProvider.tsx': REASON,
  'components/features/knowledge/KnowledgeWorkspace.tsx': REASON,
  'components/features/knowledge/comments/CommentsSection.tsx': REASON,
  'components/features/knowledge/comments/useAnnotationActions.ts': REASON,
  'components/features/knowledge/notes/PageNotesLayer.tsx': REASON,
  'components/features/knowledge/useKnowledgeMutations.ts': REASON,
  'components/features/mailbox-connections/MailboxAgentAccess.tsx': REASON,
  'components/features/workflow-tools/ToolReviewActions.tsx': REASON,
  'components/features/workflow-tools/ToolReviewBar.tsx': REASON,
  'components/features/workflows/DemonstrationDraftsColumn.tsx': REASON,
  'components/features/workflows/WorkflowInstallationDetail.tsx': REASON,
  'components/features/workflows/WorkflowRunDetail.tsx': REASON,
  'components/features/projects/kanban/ArchiveDoneMenu.tsx': REASON,
  'components/features/projects/kanban/TaskDocuments.tsx': REASON,
  'components/shared/ChannelMembersPopup.tsx': REASON,
  'components/shared/CreateProjectDialog.tsx': REASON,
  'components/shared/ProjectMembersDialog.tsx': REASON,
  'facades/channels/dm-navigation.ts': REASON,
  'layouts/admin-shell/AlertsBell.tsx': REASON,
  'layouts/admin-shell/user-menu/StatusSection.tsx': REASON,
  'pages/AgentDesignerPage.tsx': REASON,
  'pages/AlertsPage.tsx': REASON,
  'pages/AppDetailPage.tsx': REASON,
  'pages/ApprovalsPage.tsx': REASON,
  'pages/ChannelsPage.tsx': REASON,
  'pages/IntegrationsPage.tsx': REASON,
  'pages/OpsHealthPage.tsx': REASON,
  'pages/WorkflowsPage.tsx': REASON,
  'pages/channels/ThreadInboxCard.tsx': REASON,
  'pages/channels/useChannelTitleFavorite.ts': REASON,
  'pages/project/ProjectBacklogTab.tsx': REASON,
  'pages/project/ProjectBoardTab.tsx': REASON,
  'pages/settings/connections/ConnectionCard.tsx': REASON,
  'pages/settings/connections/SendAuthorizationSection.tsx': REASON,
}

type MutationFile = {
  guarded: boolean
  path: string
}

const mutationFiles: MutationFile[] = []
for (const path of walk(SRC).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))) {
  const source = stripComments(readFileSync(path, 'utf8'))
  if (!MUTATE_CALL.test(source)) continue
  mutationFiles.push({
    guarded: READS_ITS_OWN_ERROR.test(source),
    path: relative(SRC, path).replaceAll('\\', '/'),
  })
}

test('the scan finds the admin\'s mutation call sites at all', () => {
  // A detector that silently matches nothing would make every assertion
  // below vacuous, which is how this class of test rots.
  assert.ok(
    mutationFiles.length >= 100,
    `expected the admin's mutation-bearing files, found ${mutationFiles.length}`,
  )
})

test('every mutation call site reads its own error or is allowlisted', () => {
  const offenders = mutationFiles
    .filter((file) => !file.guarded && !(file.path in MUTATION_FEEDBACK_ALLOWLIST))
    .map((file) => file.path)
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')}: a mutation call with no onError/catch/toFormErrors/formErrorMessage `
    + 'in the file. Add one, surface the failure (a form error or a toast), or add this file to '
    + 'MUTATION_FEEDBACK_ALLOWLIST in admin/test/mutation-feedback.test.ts with a reason.',
  )
})

test('no mutation-feedback exception has stopped needing to be one', () => {
  for (const [path, reason] of Object.entries(MUTATION_FEEDBACK_ALLOWLIST)) {
    const file = mutationFiles.find((candidate) => candidate.path === path)
    assert.ok(
      file,
      `${path}: listed in MUTATION_FEEDBACK_ALLOWLIST, but it no longer calls a mutation. `
      + 'Delete the entry.',
    )
    assert.ok(
      !file.guarded,
      `${path}: now reads its own error (onError/catch/toFormErrors/formErrorMessage). `
      + 'Delete the entry.',
    )
    assert.ok(
      reason.length >= 40,
      `${path}: an exception carries a reason explaining why it is not yet converted.`,
    )
  }
})
