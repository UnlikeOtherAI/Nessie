import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ConnectionContext,
  SourceRejectedError,
  type SyncCheckpoint,
} from '@nessie/board-sources'

import { createLinearAdapter } from '../src/adapter.js'
import type { LinearGraphQl } from '../src/lanes.js'
import {
  type LinearComment,
  type LinearIssue,
  normaliseLinearComment,
  normaliseLinearIssue,
  normaliseLinearLabel,
} from '../src/normalise.js'
import { parseLinearWebhook } from '../src/webhook-parse.js'

const ctx: ConnectionContext = {
  connectionId: 'connection-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  provider: 'linear',
  externalAccountId: 'acct-1',
  externalTenantId: 'tenant-1',
  credential: { accessToken: 'lin_api_test', scopes: [] },
}

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'issue-1',
  identifier: 'ENG-42',
  url: 'https://linear.app/acme/issue/ENG-42',
  title: 'Ship it',
  description: 'See ![shot](https://uploads.linear.app/a/b/screen.png) and [PR](https://github.com/acme/x/pull/1)',
  priority: 2,
  estimate: 3,
  dueDate: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archivedAt: null,
  state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
  assignee: null,
  labels: { nodes: [{ id: 'label-1', name: 'Bug', color: '#EB5757' }] },
  ...over,
})

const comment = (over: Partial<LinearComment> = {}): LinearComment => ({
  id: 'comment-1',
  body: 'Looks good',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  editedAt: null,
  url: 'https://linear.app/acme/issue/ENG-42#comment-1',
  user: { id: 'user-a', name: 'Alice', email: 'alice@example.test' },
  botActor: null,
  issue: { id: 'issue-1' },
  parent: null,
  ...over,
})

/** Answers queries in order and records what each was asked. */
const scripted = (answers: unknown[]) => {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const gql: LinearGraphQl = async <T>(
    _token: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push({ query, variables })
    if (answers.length === 0) throw new Error(`unexpected query: ${query.slice(0, 60)}`)
    return answers.shift() as T
  }
  return { gql, calls }
}

test('labels carry their colour, lower-cased, and a grouped label names its group', () => {
  assert.deepEqual(normaliseLinearLabel({ id: 'l1', name: 'Bug', color: '#EB5757' }), {
    id: 'l1',
    label: 'Bug',
    color: '#eb5757',
  })
  assert.deepEqual(
    normaliseLinearLabel({ id: 'l2', name: 'Web', color: '#5e6ad2', parent: { id: 'g', name: 'Area' } }),
    { id: 'l2', label: 'Area / Web', color: '#5e6ad2' },
  )
  // Anything that is not a six-digit hex is dropped rather than stored; the
  // apply step then uses the default colour.
  assert.deepEqual(normaliseLinearLabel({ id: 'l3', name: 'Odd', color: 'red' }), {
    id: 'l3',
    label: 'Odd',
  })
})

test('attachments are files on Linear’s upload host and links everywhere else, plus inline uploads', () => {
  const item = normaliseLinearIssue(
    issue({
      attachments: {
        nodes: [
          {
            id: 'att-file',
            title: 'spec.pdf',
            url: 'https://uploads.linear.app/a/b/spec.pdf',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'att-link',
            title: 'Pull request',
            url: 'https://github.com/acme/x/pull/1',
            sourceType: 'github',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
      comments: {
        nodes: [comment({ body: 'Repro: ![](https://uploads.linear.app/a/c/repro.gif)' })],
      },
    }),
  )
  const byUrl = new Map((item.attachments ?? []).map((a) => [a.url, a]))
  assert.equal(byUrl.get('https://uploads.linear.app/a/b/spec.pdf')?.kind, 'file')
  assert.equal(byUrl.get('https://uploads.linear.app/a/b/spec.pdf')?.inline, undefined)
  assert.equal(byUrl.get('https://github.com/acme/x/pull/1')?.kind, 'link')
  // The description's screenshot is an inline file; its GitHub link is prose.
  const shot = byUrl.get('https://uploads.linear.app/a/b/screen.png')
  assert.equal(shot?.kind, 'file')
  assert.equal(shot?.inline, true)
  assert.equal(shot?.commentExternalId, undefined)
  const repro = byUrl.get('https://uploads.linear.app/a/c/repro.gif')
  assert.equal(repro?.inline, true)
  assert.equal(repro?.commentExternalId, 'comment-1')
  assert.equal(item.attachments?.length, 4)
  assert.equal(item.comments?.length, 1)
})

test('an issue read without comments leaves them undefined, never empty', () => {
  // `undefined` means "not read on this call, leave what is stored"; an empty
  // list would read as "every comment was deleted".
  assert.equal(normaliseLinearIssue(issue()).comments, undefined)
})

test('a bot comment has no author and is shown under the integration’s name', () => {
  const normalised = normaliseLinearComment(
    comment({ user: null, botActor: { id: 'bot', name: 'GitHub' } }),
  )
  assert.equal(normalised.author, null)
  assert.equal(normalised.authorDisplay, 'GitHub')
  const person = normaliseLinearComment(comment())
  assert.equal(person.author?.externalUserId, 'user-a')
  assert.equal(person.author?.email, 'alice@example.test')
  assert.equal(person.issueExternalId, 'issue-1')
})

test('the item lane hands over to the comment lane, which pages and hands back', async () => {
  const { gql, calls } = scripted([
    {
      issues: {
        nodes: [issue({ updatedAt: '2026-09-10T00:10:00.000Z' })],
        pageInfo: { hasNextPage: false, endCursor: 'issues-end' },
      },
    },
    {
      comments: {
        nodes: [comment({ updatedAt: '2026-09-10T00:05:00.000Z' })],
        pageInfo: { hasNextPage: true, endCursor: 'comments-1' },
      },
    },
    {
      comments: {
        nodes: [comment({ id: 'comment-2', updatedAt: '2026-09-10T00:20:00.000Z' })],
        pageInfo: { hasNextPage: false, endCursor: 'comments-2' },
      },
    },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const container = { teamId: 'team-1' }
  const options = { syncWindowDays: 30 }

  const first = await adapter.fetchPage(ctx, container, { phase: 'initial' }, options)
  assert.equal(first.items.length, 1)
  assert.equal(first.hasMore, true, 'the comment lane still has to run')
  assert.equal(first.checkpoint.lane, 'comments')
  // A lane with no clock of its own walks from the epoch, so a first sync
  // brings every comment the mirrored issues already have.
  assert.equal(first.checkpoint.commentsSince, '1970-01-01T00:00:00.000Z')
  assert.equal(first.checkpoint.since, '2026-09-10T00:09:00.000Z')
  assert.equal(first.checkpoint.phase, 'incremental')

  const second = await adapter.fetchPage(ctx, container, first.checkpoint, options)
  assert.deepEqual(second.items, [])
  assert.equal(second.comments?.length, 1)
  assert.equal(second.hasMore, true)
  assert.equal(second.checkpoint.commentsCursor, 'comments-1')
  assert.equal(calls[1]?.variables.updatedAfter, '1970-01-01T00:00:00.000Z')
  assert.equal(calls[1]?.variables.teamId, 'team-1')
  assert.match(calls[1]?.query ?? '', /comments\(/)
  assert.doesNotMatch(calls[0]?.query ?? '', /comments\(/, 'the item page never nests comments')

  const third = await adapter.fetchPage(ctx, container, second.checkpoint, options)
  assert.equal(third.hasMore, false)
  assert.equal(third.checkpoint.lane, 'items')
  assert.equal(third.checkpoint.commentsCursor, undefined)
  assert.equal(third.checkpoint.commentsSince, '2026-09-10T00:19:00.000Z')
  // The item clock is carried across the comment lane untouched.
  assert.equal(third.checkpoint.since, '2026-09-10T00:09:00.000Z')
  assert.equal(calls[2]?.variables.after, 'comments-1')
})

test('an incremental item lane keeps the comment clock it was handed', async () => {
  const { gql } = scripted([
    { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const checkpoint: SyncCheckpoint = {
    phase: 'incremental',
    since: '2026-09-10T00:00:00.000Z',
    lane: 'items',
    commentsSince: '2026-09-09T00:00:00.000Z',
  }
  const page = await adapter.fetchPage(ctx, { teamId: 'team-1' }, checkpoint, { syncWindowDays: 30 })
  assert.equal(page.checkpoint.lane, 'comments')
  assert.equal(page.checkpoint.commentsSince, '2026-09-09T00:00:00.000Z')
  assert.equal(page.checkpoint.since, '2026-09-10T00:00:00.000Z')
})

test('the webhook re-read is narrowed to the source’s team and reads comments', async () => {
  const { gql, calls } = scripted([
    { issues: { nodes: [issue({ comments: { nodes: [comment()] } })] } },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const items = await adapter.fetchItems(ctx, { teamId: 'team-1' }, ['issue-1'])
  assert.equal(items[0]?.comments?.length, 1)
  assert.equal(calls[0]?.variables.teamId, 'team-1')
  assert.match(calls[0]?.query ?? '', /team: \{ id: \{ eq: \$teamId \} \}/)
})

test('describing a team lists team and workspace labels first-class, and no Labels field', async () => {
  const { gql } = scripted([
    {
      team: {
        states: { nodes: [{ id: 's1', name: 'Todo', type: 'unstarted', position: 0 }] },
        members: { nodes: [] },
        labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#eb5757' }] },
      },
    },
    { issueLabels: { nodes: [{ id: 'l2', name: 'Customer', color: '#4ea7fc' }] } },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const description = await adapter.describeContainer(ctx, { teamId: 'team-1' })
  assert.deepEqual(description.fields.map((field) => field.key), ['estimate'])
  assert.deepEqual(description.labels, [
    { id: 'l1', label: 'Bug', color: '#eb5757' },
    { id: 'l2', label: 'Customer', color: '#4ea7fc' },
  ])
})

test('applyChange sends labelIds, and the old fields.labels arm is gone', async () => {
  const { gql, calls } = scripted([
    { issueUpdate: { success: true, issue: issue() } },
    { issueUpdate: { success: true, issue: issue() } },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const item = { externalId: 'issue-1', externalKey: 'ENG-42' }
  await adapter.applyChange(ctx, { teamId: 'team-1' }, item, { labelIds: ['l1', 'l2'] })
  assert.deepEqual((calls[0]?.variables.input as Record<string, unknown>).labelIds, ['l1', 'l2'])

  await assert.rejects(
    adapter.applyChange(ctx, { teamId: 'team-1' }, item, { fields: { labels: ['l9'] } }),
    (error: unknown) => error instanceof SourceRejectedError && error.code === 'NOTHING_TO_APPLY',
  )
  assert.equal(calls.length, 1, 'fields.labels alone sends nothing upstream')
})

test('comment create, update and delete run their mutations and normalise the echo', async () => {
  const { gql, calls } = scripted([
    { commentCreate: { success: true, comment: comment({ id: 'new-1', body: 'From Nessie' }) } },
    { commentUpdate: { success: true, comment: comment({ id: 'new-1', body: 'Edited' }) } },
    { commentDelete: { success: true } },
    { commentCreate: { success: false, comment: null } },
  ])
  const adapter = createLinearAdapter({ graphQl: gql })
  const container = { teamId: 'team-1' }

  const created = await adapter.createComment?.(
    ctx,
    container,
    { externalId: 'issue-1', externalKey: 'ENG-42' },
    'From Nessie',
  )
  assert.equal(created?.externalId, 'new-1')
  assert.equal(created?.issueExternalId, 'issue-1')
  assert.deepEqual(calls[0]?.variables.input, { issueId: 'issue-1', body: 'From Nessie' })

  const updated = await adapter.updateComment?.(ctx, container, { externalId: 'new-1' }, 'Edited')
  assert.equal(updated?.body, 'Edited')
  assert.deepEqual(calls[1]?.variables, { id: 'new-1', input: { body: 'Edited' } })

  await adapter.deleteComment?.(ctx, container, { externalId: 'new-1' })
  assert.deepEqual(calls[2]?.variables, { id: 'new-1' })

  await assert.rejects(
    adapter.createComment?.(ctx, container, { externalId: 'issue-1', externalKey: 'ENG-42' }, 'x')
      ?? Promise.resolve(),
    (error: unknown) => error instanceof SourceRejectedError && error.code === 'LINEAR_COMMENT_REFUSED',
  )
})

test('the adapter declares Linear’s upload host as its only asset host', () => {
  assert.deepEqual(createLinearAdapter({}).assetHosts, ['uploads.linear.app'])
})

const delivery = (payload: Record<string, unknown>) =>
  parseLinearWebhook({ provider: 'linear', headers: {}, rawBody: JSON.stringify(payload) })

test('a Comment delivery names its issue, and a removal names the comment', () => {
  const created = delivery({
    type: 'Comment',
    action: 'create',
    webhookId: 'wh',
    webhookTimestamp: 1,
    data: { id: 'comment-1', issueId: 'issue-1' },
  })
  assert.deepEqual(created.externalIds, ['issue-1'])
  assert.equal(created.resource, 'item')
  assert.equal(created.removedCommentExternalIds, undefined)

  const removed = delivery({
    type: 'Comment',
    action: 'remove',
    data: { id: 'comment-1', issueId: 'issue-1' },
  })
  assert.deepEqual(removed.externalIds, ['issue-1'])
  assert.deepEqual(removed.removedCommentExternalIds, ['comment-1'])
})

test('an IssueLabel delivery asks for a re-describe, not an item', () => {
  const parsed = delivery({
    type: 'IssueLabel',
    action: 'update',
    data: { id: 'label-1', teamId: 'team-1', color: '#000000' },
  })
  assert.equal(parsed.resource, 'label')
  assert.deepEqual(parsed.externalIds, [])
  assert.equal(parsed.containerKey, 'team-1')
  // A workspace label has no team, so every Linear source re-describes.
  assert.equal(delivery({ type: 'IssueLabel', data: { id: 'l', teamId: null } }).containerKey, null)
})

test('an Issue delivery is unchanged: the issue id, keyed to its team', () => {
  const parsed = delivery({ type: 'Issue', action: 'update', data: { id: 'issue-1', teamId: 'team-1' } })
  assert.deepEqual(parsed.externalIds, ['issue-1'])
  assert.equal(parsed.containerKey, 'team-1')
  assert.equal(parsed.resource, 'item')
})
