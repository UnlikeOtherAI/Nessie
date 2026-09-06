import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath: string): string =>
  readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8')

// Every surface that holds a person's unsent words, and the entity its draft is
// keyed by (docs/navigation/overview.md → "Drafts"). A surface added to the admin that
// keeps such state in `useState` alone belongs on this list, not beside it.
const ADOPTED_SURFACES: { file: string; key: string; label: string }[] = [
  {
    file: 'components/features/channels/useChannelComposer.ts',
    key: 'draftKey',
    label: 'the channel, DM, reply and drawer composers (one hook)',
  },
  {
    file: 'components/features/channels/useChannelMessageActions.tsx',
    key: "draftKey('message-edit', editingMessageId)",
    label: 'message inline edit',
  },
  {
    file: 'components/features/projects/kanban/TaskDialog.tsx',
    key: "draftKey('task', task?.id ?? 'new')",
    label: 'the task dialog',
  },
  {
    file: 'components/features/agents/designer/useAgentDesigner.ts',
    key: "draftKey('agent-designer', agentId ?? 'new')",
    label: 'the agent designer',
  },
  {
    file: 'components/features/knowledge/PageEditor.tsx',
    key: "draftKey('kb-page', page?.id ?? 'new')",
    label: 'the knowledge page editor',
  },
  {
    file: 'components/features/triggers/TriggerEditorDialog.tsx',
    key: "draftKey('trigger', trigger?.id ?? 'new')",
    label: 'the trigger editor',
  },
  {
    file: 'pages/DashboardDetailPage.tsx',
    key: "draftKey('dashboard-layout', dashboardId)",
    label: 'dashboard edit mode',
  },
]

for (const surface of ADOPTED_SURFACES) {
  test(`${surface.label} keeps its draft through useDraft, keyed by its entity`, () => {
    const source = read(surface.file)
    assert.match(
      source,
      /\buseDraft(<[^>]+>)?\(/,
      `${surface.file} must hold its unsent state in useDraft, not useState alone`,
    )
    assert.ok(
      source.includes(surface.key),
      `${surface.file} must key its draft on ${surface.key}`,
    )
  })

  test(`${surface.label} never asks whether to discard a draft`, () => {
    const source = read(surface.file)
    // The one confirm that stays is `useLeaveGuard`'s streaming-document one,
    // and it lives nowhere near these files.
    // A call, not the word: several of these files carry a comment about the
    // blocking `window.confirm` they replaced.
    assert.doesNotMatch(source, /window\.confirm\s*\(/)
    assert.doesNotMatch(source, /[Dd]iscard changes/)
    assert.doesNotMatch(source, /[Dd]iscard\?/)
  })
}

test('the channel composer keys its draft per channel and the reply panel per root', () => {
  const draftKeys = read('components/features/channels/composer-draft.ts')
  assert.match(draftKeys, /channelComposerDraftKey[\s\S]*draftKey\('composer', channelId\)/)
  assert.match(draftKeys, /replyComposerDraftKey[\s\S]*draftKey\('reply', rootMessageId\)/)

  // The reset-on-channel-change leak the plan names: both the text and the
  // staged attachments have to be keyed, or they follow the person.
  assert.match(draftKeys, /attachments: StagedAttachment\[\]/)
  assert.match(draftKeys, /text: string/)

  const channelsPage = read('pages/ChannelsPage.tsx')
  assert.match(channelsPage, /draftKey: channelComposerDraftKey\(activeChannel\?\.id\)/)
  const replyPanel = read('components/features/channels/thread-panel/ThreadReplyPanel.tsx')
  assert.match(replyPanel, /draftKey: replyComposerDraftKey\(openRootMessageId\)/)
})

test('only finished uploads reach the stored draft — never file bytes', () => {
  const source = read('components/features/channels/composer-draft.ts')
  assert.match(source, /entry\.status === 'done' && Boolean\(entry\.attachmentId\)/)
  assert.doesNotMatch(source, /\bFile\b/)
  assert.doesNotMatch(source, /dataBase64|ArrayBuffer|Blob/)
})

test('a composer draft carrying a detected credential is never stored', () => {
  const source = read('components/features/channels/composer-draft.ts')
  assert.match(source, /detectSecrets\(draft\.text\)\.length > 0/)
})

test('the composers send one idempotency key per unsent draft', () => {
  const composer = read('components/features/channels/useChannelComposer.ts')
  assert.match(composer, /clientMessageIdRef/)
  assert.match(composer, /clientMessageId,/)
  // Reset on a successful send and on a channel switch — never reused across
  // two different posts.
  assert.match(composer, /clientMessageIdRef\.current = null/)

  const hooks = read('facades/messages/hooks.ts')
  assert.match(hooks, /clientMessageId\?: string/)
})

test('the conditional writes send If-Match and offer the choice in place', () => {
  const dashboards = read('facades/dashboards/hooks.ts')
  assert.match(dashboards, /'if-match': String\(revision\)/)
  const workflows = read('facades/workflows/hooks.ts')
  assert.match(workflows, /'if-match': String\(expectedVersion\)/)

  // Never a blocking dialog: both surfaces render keep-mine / take-theirs.
  const dashboardPage = read('pages/DashboardDetailPage.tsx')
  assert.match(dashboardPage, /Keep mine/)
  assert.match(dashboardPage, /Take theirs/)
  const designerHeader = read('components/features/workflow-designer/WorkflowDesignerHeader.tsx')
  assert.match(designerHeader, /Keep mine/)
  assert.match(designerHeader, /Take theirs/)
})

test('Escape on an inline edit closes the editor without discarding the draft', () => {
  const source = read('components/features/channels/useChannelMessageActions.tsx')
  // cancelEdit closes only; the text stays under the message's draft key and
  // is cleared by a successful save.
  assert.match(source, /const cancelEdit = useCallback\(\(\) => \{\s*setEditingMessageId\(null\)\s*\}/)
  assert.match(source, /editDraft\.clear\(\)/)
})
