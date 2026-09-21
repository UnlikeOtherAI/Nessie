import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type {
  ConnectionContext,
  SourceFetchInput,
  SourceFetchStreamInput,
  SyncCheckpoint,
} from '@nessie/board-sources'
import { SourceHttpError, itemFingerprint } from '@nessie/board-sources'

import { buildRepositoryHookBody, createGitHubAdapter } from '../src/adapter.js'
import type { GitHubTransport } from '../src/http.js'
import {
  type GitHubComment,
  type GitHubIssue,
  gitHubInlineAssets,
  normaliseGitHubComment,
  normaliseGitHubIssue,
  normaliseGitHubLabel,
} from '../src/normalise.js'
import { parseGitHubWebhook } from '../src/webhook-parse.js'

const ctx: ConnectionContext = {
  connectionId: 'connection-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  provider: 'github',
  externalAccountId: '1',
  externalTenantId: '',
  credential: { accessToken: 'gho_test', scopes: ['repo'] },
}
const repo = { kind: 'repository', owner: 'acme', repo: 'app' }

const issue = (over: Partial<GitHubIssue> = {}): GitHubIssue => ({
  id: 1,
  node_id: 'I_node17',
  number: 17,
  html_url: 'https://github.com/acme/app/issues/17',
  title: 'Ship it',
  body: 'Shot: ![s](https://github.com/user-attachments/assets/abc-123) see [PR](https://github.com/acme/app/pull/3)',
  state: 'open',
  state_reason: null,
  assignee: null,
  labels: [{ id: 5, name: 'bug', color: 'D73A4A' }],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  ...over,
})

const comment = (over: Partial<GitHubComment> = {}): GitHubComment => ({
  id: 901,
  html_url: 'https://github.com/acme/app/issues/17#issuecomment-901',
  issue_url: 'https://api.github.com/repos/acme/app/issues/17',
  body: 'Looks good',
  user: { id: 42, login: 'alice', type: 'User' },
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  ...over,
})

type Call = { kind: 'json' | 'raw' | 'stream'; input: SourceFetchInput | SourceFetchStreamInput }

/** Answers calls in order and records each; an unexpected call fails loudly. */
const recorded = (answers: ((call: Call) => unknown)[]) => {
  const calls: Call[] = []
  const next = (call: Call) => {
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected ${call.kind} ${call.input.url}`)
    return answer(call)
  }
  const transport: GitHubTransport = {
    json: async <T>(input: SourceFetchInput) => next({ kind: 'json', input }) as T,
    raw: async (input) => next({ kind: 'raw', input }) as Awaited<ReturnType<GitHubTransport['raw']>>,
    stream: async (input) =>
      next({ kind: 'stream', input }) as Awaited<ReturnType<GitHubTransport['stream']>>,
  }
  return { transport, calls }
}

const adapterWith = (transport: GitHubTransport) =>
  createGitHubAdapter({ clientId: 'id', clientSecret: 'secret', transport })

test('a label carries its colour as #rrggbb; a missing or odd colour is dropped', () => {
  assert.deepEqual(normaliseGitHubLabel({ id: 5, name: 'bug', color: 'D73A4A' }), {
    id: '5',
    label: 'bug',
    color: '#d73a4a',
  })
  assert.deepEqual(normaliseGitHubLabel({ id: 6, name: 'odd', color: 'red' }), { id: '6', label: 'odd' })
  assert.deepEqual(normaliseGitHubLabel('legacy'), { id: 'legacy', label: 'legacy' })
})

test('fields.labels is kept beside the native labels so fingerprints do not move on upgrade', () => {
  const item = normaliseGitHubIssue(issue())
  assert.deepEqual(item.fields.labels, ['5'])
  assert.deepEqual(item.labels, [{ id: '5', label: 'bug', color: '#d73a4a' }])
  // What a source mapping `labels` hashed before this change: the same ids.
  const before = { ...item, fields: { labels: ['5'] } }
  assert.equal(itemFingerprint(item, ['labels']), itemFingerprint(before, ['labels']))
})

test('only pasted uploads are inline files — Markdown and HTML — never a link to a page', () => {
  const assets = gitHubInlineAssets(
    [
      '![a](https://github.com/user-attachments/assets/abc-123)',
      '<img width="300" alt="b" src="https://github.com/user-attachments/assets/def-456" />',
      '[log](https://github.com/user-attachments/files/77/build.log)',
      '![old](https://user-images.githubusercontent.com/1/old.png)',
      '[PR](https://github.com/acme/app/pull/3) and ![ext](https://example.com/x.png)',
    ].join('\n'),
    { issueExternalId: 'I_node17', createdAt: '2026-09-01T00:00:00Z' },
  )
  assert.deepEqual(
    assets.map((asset) => asset.url).sort(),
    [
      'https://github.com/user-attachments/assets/abc-123',
      'https://github.com/user-attachments/assets/def-456',
      'https://github.com/user-attachments/files/77/build.log',
      'https://user-images.githubusercontent.com/1/old.png',
    ],
  )
  assert.ok(assets.every((asset) => asset.kind === 'file' && asset.inline === true))
})

test('an issue read without comments leaves them undefined; with them, their uploads hang off the comment', () => {
  assert.equal(normaliseGitHubIssue(issue()).comments, undefined)
  const item = normaliseGitHubIssue(issue(), [
    comment({ body: 'Repro <img src="https://github.com/user-attachments/assets/zzz">' }),
  ])
  assert.equal(item.comments?.[0]?.issueExternalId, 'I_node17')
  const repro = item.attachments?.find((a) => a.url.endsWith('/zzz'))
  assert.equal(repro?.commentExternalId, '901')
  assert.equal(item.attachments?.find((a) => a.url.endsWith('abc-123'))?.commentExternalId, undefined)
})

test('a bot comment has no author and shows its login; an edit is read from updated_at', () => {
  const bot = normaliseGitHubComment(comment({ user: { id: 7, login: 'dependabot[bot]', type: 'Bot' } }), 'I')
  assert.equal(bot.author, null)
  assert.equal(bot.authorDisplay, 'dependabot[bot]')
  const edited = normaliseGitHubComment(comment({ updated_at: '2026-09-04T00:00:00Z' }), 'I')
  assert.equal(edited.editedAt, '2026-09-04T00:00:00Z')
  assert.deepEqual(edited.author, { externalUserId: '42', displayName: 'alice' })
})

test('the issues lane hands over to the comment lane, which resolves issue numbers to node ids', async () => {
  const { transport, calls } = recorded([
    () => [issue()],
    // Comment lane page 1: one on the issue, one on a pull request, one on a
    // number that no longer resolves.
    () => [
      comment(),
      comment({ id: 902, issue_url: 'https://api.github.com/repos/acme/app/issues/3' }),
      comment({ id: 903, issue_url: 'https://api.github.com/repos/acme/app/issues/99', updated_at: '2026-09-05T00:00:00Z' }),
    ],
    () => ({
      data: { repository: { i17: { __typename: 'Issue', id: 'I_node17' }, i3: { __typename: 'PullRequest' }, i99: null } },
      errors: [{ message: 'Could not resolve to an issue or pull request with the number of 99.' }],
    }),
  ])
  const adapter = adapterWith(transport)
  const first = await adapter.fetchPage(ctx, repo, { phase: 'initial' }, { syncWindowDays: 30 })
  assert.equal(first.hasMore, true)
  assert.equal(first.checkpoint.lane, 'comments')
  assert.equal(first.checkpoint.commentsSince, '1970-01-01T00:00:00.000Z')

  const second = await adapter.fetchPage(ctx, repo, first.checkpoint, { syncWindowDays: 30 })
  assert.deepEqual(second.comments?.map((c) => [c.externalId, c.issueExternalId]), [['901', 'I_node17']])
  assert.equal(second.hasMore, false)
  assert.equal(second.checkpoint.lane, 'items')
  // The clock advances past every row read, less a minute of overlap.
  assert.equal(second.checkpoint.commentsSince, '2026-09-04T23:59:00.000Z')
  const laneUrl = new URL(calls[1]?.input.url as string)
  assert.equal(laneUrl.pathname, '/repos/acme/app/issues/comments')
  assert.equal(laneUrl.searchParams.get('sort'), 'updated')
  assert.equal(laneUrl.searchParams.get('direction'), 'asc')
  assert.equal(laneUrl.searchParams.get('since'), '1970-01-01T00:00:00.000Z')
})

test('a full comment page keeps the lane open on the next page number', async () => {
  const page = Array.from({ length: 50 }, (_, i) => comment({ id: 1000 + i }))
  const { transport } = recorded([
    () => page,
    () => ({ data: { repository: { i17: { __typename: 'Issue', id: 'I_node17' } } } }),
  ])
  const checkpoint: SyncCheckpoint = { phase: 'incremental', lane: 'comments', commentsSince: '2026-09-01T00:00:00.000Z' }
  const next = await adapterWith(transport).fetchPage(ctx, repo, checkpoint, { syncWindowDays: 30 })
  assert.equal(next.hasMore, true)
  assert.equal(next.checkpoint.lane, 'comments')
  assert.equal(next.checkpoint.commentsCursor, '2')
  assert.equal(next.checkpoint.commentsSince, '2026-09-01T00:00:00.000Z')
  assert.equal(next.comments?.length, 50)
})

test('the webhook path re-reads an issue with its comments', async () => {
  const { transport } = recorded([() => issue(), () => [comment()]])
  const [item] = await adapterWith(transport).fetchItems(ctx, repo, ['17'])
  assert.equal(item?.comments?.[0]?.externalId, '901')
})

test('describe lists labels with colour and no longer declares a labels field', async () => {
  const { transport } = recorded([
    () => [{ id: 42, login: 'alice' }],
    () => [{ id: 5, name: 'bug', color: 'd73a4a' }, { id: 6, name: 'docs', color: '0075ca' }],
  ])
  const description = await adapterWith(transport).describeContainer(ctx, repo)
  assert.deepEqual(description.fields, [])
  assert.deepEqual(description.labels, [
    { id: '5', label: 'bug', color: '#d73a4a' },
    { id: '6', label: 'docs', color: '#0075ca' },
  ])
})

test('webhooks: comment deletions carry the comment id; label events re-describe', () => {
  const headers = (event: string) => ({ 'x-github-event': event, 'x-github-delivery': 'd-1' })
  const deleted = parseGitHubWebhook({
    provider: 'github',
    headers: headers('issue_comment'),
    rawBody: JSON.stringify({ action: 'deleted', issue: { number: 17 }, comment: { id: 901 }, repository: { full_name: 'acme/app' } }),
  })
  assert.deepEqual(deleted.externalIds, ['17'])
  assert.deepEqual(deleted.removedCommentExternalIds, ['901'])
  assert.equal(deleted.containerKey, 'repo:acme/app')
  const label = parseGitHubWebhook({
    provider: 'github',
    headers: headers('label'),
    rawBody: JSON.stringify({ action: 'edited', label: { id: 5 }, repository: { full_name: 'acme/app' } }),
  })
  assert.equal(label.resource, 'label')
  assert.deepEqual(label.externalIds, [])
  assert.deepEqual(buildRepositoryHookBody({ url: 'u', secret: 's' }).events, ['issues', 'issue_comment', 'label'])
})

test('write-back: labels by name, and the three comment calls with their echoes', async () => {
  const { transport, calls } = recorded([
    () => [{ id: 5, name: 'bug' }, { id: 6, name: 'docs' }],
    () => issue({ labels: [{ id: 6, name: 'docs', color: '0075ca' }] }),
    () => comment({ id: 950, body: 'From Nessie' }),
    () => comment({ id: 950, body: 'Edited', updated_at: '2026-09-06T00:00:00Z' }),
    () => undefined,
  ])
  const adapter = adapterWith(transport)
  const echo = await adapter.applyChange(ctx, repo, { externalId: 'I_node17', externalKey: '#17' }, { labelIds: ['6'] })
  assert.deepEqual(JSON.parse(calls[1]?.input.body as string), { labels: ['docs'] })
  assert.deepEqual(echo.labels.map((l) => l.id), ['6'])

  const created = await adapter.createComment?.(ctx, repo, { externalId: 'I_node17', externalKey: '#17' }, 'From Nessie')
  assert.equal(calls[2]?.input.url, 'https://api.github.com/repos/acme/app/issues/17/comments')
  assert.equal((calls[2]?.input as SourceFetchInput).method, 'POST')
  assert.deepEqual([created?.externalId, created?.issueExternalId, created?.body], ['950', 'I_node17', 'From Nessie'])

  const updated = await adapter.updateComment?.(ctx, repo, { externalId: '950' }, 'Edited')
  assert.equal(calls[3]?.input.url, 'https://api.github.com/repos/acme/app/issues/comments/950')
  assert.equal((calls[3]?.input as SourceFetchInput).method, 'PATCH')
  assert.equal(updated?.editedAt, '2026-09-06T00:00:00Z')

  await adapter.deleteComment?.(ctx, repo, { externalId: '950' })
  assert.equal((calls[4]?.input as SourceFetchInput).method, 'DELETE')
})

test('a label that no longer exists upstream is refused rather than dropped', async () => {
  const { transport } = recorded([() => [{ id: 5, name: 'bug' }]])
  await assert.rejects(
    adapterWith(transport).applyChange(ctx, repo, { externalId: 'I', externalKey: '#17' }, { labelIds: ['404'] }),
    /no longer exists/,
  )
})

test('fetchAsset follows the one redirect to a signed URL without the token', async () => {
  const stream = Readable.from([Buffer.from('png')])
  const { transport, calls } = recorded([
    () => ({
      status: 302,
      headers: new Headers({ location: 'https://private-user-images.githubusercontent.com/1/x.png?jwt=abc' }),
      text: '',
    }),
    () => ({ status: 200, stream, contentType: 'image/png', sizeBytes: 3 }),
  ])
  const adapter = adapterWith(transport)
  const asset = await adapter.fetchAsset?.(ctx, { url: 'https://github.com/user-attachments/assets/abc-123' })
  assert.equal(asset?.contentType, 'image/png')
  assert.equal((calls[0]?.input as SourceFetchInput).method, 'HEAD')
  assert.equal(calls[0]?.input.headers?.authorization, 'Bearer gho_test')
  assert.equal(calls[1]?.input.url, 'https://private-user-images.githubusercontent.com/1/x.png?jwt=abc')
  assert.equal(calls[1]?.input.headers?.authorization, undefined)
})

test('fetchAsset refuses an unexpected redirect, answers null for a 404 and for a non-upload URL', async () => {
  const offsite = recorded([
    () => ({ status: 302, headers: new Headers({ location: 'https://evil.example/x' }), text: '' }),
  ])
  await assert.rejects(
    adapterWith(offsite.transport).fetchAsset?.(ctx, { url: 'https://github.com/user-attachments/assets/a' }) ?? Promise.resolve(),
    SourceHttpError,
  )
  const gone = recorded([
    () => {
      throw new SourceHttpError(404, 'Not Found')
    },
  ])
  assert.equal(
    await adapterWith(gone.transport).fetchAsset?.(ctx, { url: 'https://github.com/user-attachments/assets/a' }),
    null,
  )
  // A page is never dialled as a file.
  const none = recorded([])
  assert.equal(await adapterWith(none.transport).fetchAsset?.(ctx, { url: 'https://github.com/acme/app/pull/3' }), null)
  assert.equal(none.calls.length, 0)
})
