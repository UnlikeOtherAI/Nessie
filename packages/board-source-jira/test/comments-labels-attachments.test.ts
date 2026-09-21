import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { ConnectionContext, SourceFetchInput, SourceFetchStreamInput } from '@nessie/board-sources'
import { itemFingerprint } from '@nessie/board-sources'

import { JIRA_WEBHOOK_EVENTS, createJiraAdapter } from '../src/adapter.js'
import { adfToMarkdown, markdownToAdf } from '../src/adf.js'
import type { JiraTransport } from '../src/http.js'
import { type JiraComment, type JiraIssue, normaliseJiraIssue } from '../src/normalise.js'
import { parseJiraWebhook } from '../src/webhook-parse.js'

const ctx: ConnectionContext = {
  connectionId: 'connection-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  provider: 'jira',
  externalAccountId: 'acct-me',
  externalTenantId: '',
  credential: { accessToken: 'jira-token', scopes: [] },
}
const site = { cloudId: 'cloud-1', projectKey: 'ENG', siteUrl: 'https://acme.atlassian.net' }

const doc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

const comment = (over: Partial<JiraComment> = {}): JiraComment => ({
  id: '5001',
  self: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10042/comment/5001',
  author: { accountId: 'acc-a', displayName: 'Alice', emailAddress: 'alice@example.test', accountType: 'atlassian' },
  body: doc('Looks good'),
  created: '2026-09-03T00:00:00.000+0000',
  updated: '2026-09-03T00:00:00.000+0000',
  ...over,
})

const issue = (over: Partial<JiraIssue['fields']> = {}): JiraIssue => ({
  id: '10042',
  key: 'ENG-42',
  fields: {
    summary: 'Ship it',
    description: doc('Detail'),
    status: { id: '3', name: 'In Progress' },
    labels: ['backend', 'urgent-fix'],
    created: '2026-09-01T00:00:00.000+0000',
    updated: '2026-09-02T00:00:00.000+0000',
    ...over,
  },
})

type Call = { kind: 'json' | 'stream'; input: SourceFetchInput | SourceFetchStreamInput }

const recorded = (answers: ((call: Call) => unknown)[]) => {
  const calls: Call[] = []
  const next = (call: Call) => {
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected ${call.kind} ${call.input.url}`)
    return answer(call)
  }
  const transport: JiraTransport = {
    json: async <T>(input: SourceFetchInput) => next({ kind: 'json', input }) as T,
    stream: async (input) => next({ kind: 'stream', input }) as Awaited<ReturnType<JiraTransport['stream']>>,
  }
  return { transport, calls }
}

const adapterWith = (transport: JiraTransport) =>
  createJiraAdapter({ clientId: 'id', clientSecret: 'secret', transport })

test('labels are bare names with no colour; fields.labels keeps the fingerprint where it was', () => {
  const item = normaliseJiraIssue(issue(), site.siteUrl, site.cloudId)
  assert.deepEqual(item.labels, [
    { id: 'backend', label: 'backend' },
    { id: 'urgent-fix', label: 'urgent-fix' },
  ])
  assert.deepEqual(item.fields.labels, ['backend', 'urgent-fix'])
  assert.equal(
    itemFingerprint(item, ['labels']),
    itemFingerprint({ ...item, fields: { ...item.fields, labels: ['backend', 'urgent-fix'] } }, ['labels']),
  )
})

test('comments read with the issue normalise; a restricted one is flagged and carries no text', () => {
  const item = normaliseJiraIssue(
    issue({
      comment: {
        total: 3,
        comments: [
          comment(),
          comment({ id: '5002', visibility: { type: 'role', value: 'Administrators' }, body: doc('secret') }),
          comment({ id: '5003', jsdPublic: false, body: doc('internal note') }),
        ],
      },
    }),
    site.siteUrl,
    site.cloudId,
  )
  const [open, byRole, internal] = item.comments ?? []
  assert.equal(open?.body, 'Looks good')
  assert.equal(open?.restricted, undefined)
  assert.deepEqual(open?.author, { externalUserId: 'acc-a', displayName: 'Alice', email: 'alice@example.test' })
  assert.equal(open?.url, 'https://acme.atlassian.net/browse/ENG-42?focusedCommentId=5001')
  assert.equal(byRole?.restricted, true)
  assert.equal(byRole?.body, '')
  assert.equal(internal?.restricted, true)
})

test('an issue read without comment or attachment fields leaves both undefined', () => {
  const item = normaliseJiraIssue(issue(), site.siteUrl, site.cloudId)
  assert.equal(item.comments, undefined)
  assert.equal(item.attachments, undefined)
})

test('an app’s comment has no author and shows its name', () => {
  const [bot] =
    normaliseJiraIssue(
      issue({ comment: { comments: [comment({ author: { accountId: 'app-1', displayName: 'Automation', accountType: 'app' } })] } }),
      site.siteUrl,
    ).comments ?? []
  assert.equal(bot?.author, null)
  assert.equal(bot?.authorDisplay, 'Automation')
})

test('attachments are files addressed through the API gateway, the only host a 3LO token opens', () => {
  const item = normaliseJiraIssue(
    issue({
      attachment: [
        {
          id: '777',
          filename: 'trace.log',
          mimeType: 'text/plain',
          size: 2048,
          content: 'https://acme.atlassian.net/rest/api/3/attachment/content/777',
          created: '2026-09-01T00:00:00.000+0000',
        },
      ],
    }),
    site.siteUrl,
    site.cloudId,
  )
  assert.deepEqual(item.attachments, [
    {
      externalId: '777',
      issueExternalId: '10042',
      url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/content/777',
      title: 'trace.log',
      contentType: 'text/plain',
      sizeBytes: 2048,
      kind: 'file',
      createdAt: '2026-09-01T00:00:00.000+0000',
    },
  ])
})

test('ADF comments read as Markdown; Markdown goes back as paragraphs, breaks and code', () => {
  const adf = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' see ' },
          { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
        ],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc' } }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
    ],
  }
  assert.equal(adfToMarkdown(adf), 'Hello **world** see [docs](https://x.test)\n\n- one\n\n```ts\nconst a = 1\n```')
  assert.deepEqual(markdownToAdf('First line\nsecond\n\n```js\nx()\n```'), {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second' }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x()' }] },
    ],
  })
})

test('the sync page asks for comments and attachments; describe declares no labels field', async () => {
  const { transport, calls } = recorded([
    () => ({ issues: [issue({ comment: { comments: [comment()] }, attachment: [] })], isLast: true }),
    () => [{ statuses: [{ id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }] }],
    () => [],
  ])
  const adapter = adapterWith(transport)
  const page = await adapter.fetchPage(ctx, site, { phase: 'initial' }, { syncWindowDays: 30 })
  const fields = new URL(calls[0]?.input.url as string).searchParams.get('fields') ?? ''
  assert.ok(fields.split(',').includes('comment') && fields.split(',').includes('attachment'))
  assert.equal(page.items[0]?.comments?.length, 1)
  const description = await adapter.describeContainer(ctx, site)
  assert.deepEqual(description.fields.map((f) => f.key), ['issuetype'])
  assert.deepEqual(description.labels, [])
})

test('the webhook re-read tops a long thread up with its newest comments', async () => {
  const { transport, calls } = recorded([
    () => ({ issues: [issue({ comment: { total: 150, comments: [comment()] } })] }),
    () => ({ comments: [comment({ id: '5150', body: doc('newest') })] }),
  ])
  const [item] = await adapterWith(transport).fetchItems(ctx, site, ['10042'])
  assert.deepEqual(item?.comments?.map((c) => c.externalId), ['5001', '5150'])
  assert.match(calls[1]?.input.url as string, /issue\/10042\/comment\?orderBy=-created/)
})

test('webhooks: comment events re-read the issue; a deletion carries the comment id', () => {
  const deleted = parseJiraWebhook({
    provider: 'jira',
    headers: {},
    rawBody: JSON.stringify({ webhookEvent: 'comment_deleted', issue: { id: '10042' }, comment: { id: '5001' } }),
  })
  assert.deepEqual(deleted.externalIds, ['10042'])
  assert.deepEqual(deleted.removedCommentExternalIds, ['5001'])
  const created = parseJiraWebhook({
    provider: 'jira',
    headers: {},
    rawBody: JSON.stringify({ webhookEvent: 'comment_created', issue: { id: '10042' }, comment: { id: '5009' } }),
  })
  assert.equal(created.removedCommentExternalIds, undefined)
  assert.ok(JIRA_WEBHOOK_EVENTS.includes('comment_deleted'))
})

test('write-back: labels by name, and the comment calls find the issue through comment/list', async () => {
  const { transport, calls } = recorded([
    () => undefined,
    () => issue({ labels: ['frontend'] }),
    () => comment({ id: '5100', body: doc('From Nessie') }),
    () => ({ values: [comment({ id: '5100' })] }),
    () => comment({ id: '5100', body: doc('Edited'), updated: '2026-09-05T00:00:00.000+0000' }),
    () => ({ values: [comment({ id: '5100' })] }),
    () => undefined,
  ])
  const adapter = adapterWith(transport)
  const echo = await adapter.applyChange(ctx, site, { externalId: '10042', externalKey: 'ENG-42' }, { labelIds: ['frontend'] })
  assert.deepEqual(JSON.parse(calls[0]?.input.body as string), { fields: { labels: ['frontend'] } })
  assert.deepEqual(echo.labels, [{ id: 'frontend', label: 'frontend' }])

  const created = await adapter.createComment?.(ctx, site, { externalId: '10042', externalKey: 'ENG-42' }, 'From Nessie')
  assert.equal(calls[2]?.input.url, 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ENG-42/comment')
  assert.deepEqual(JSON.parse(calls[2]?.input.body as string).body, markdownToAdf('From Nessie'))
  assert.deepEqual([created?.externalId, created?.issueExternalId, created?.body], ['5100', '10042', 'From Nessie'])

  const updated = await adapter.updateComment?.(ctx, site, { externalId: '5100' }, 'Edited')
  assert.deepEqual(JSON.parse(calls[3]?.input.body as string), { ids: [5100] })
  assert.equal(calls[4]?.input.url, 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10042/comment/5100')
  assert.equal((calls[4]?.input as SourceFetchInput).method, 'PUT')
  assert.equal(updated?.body, 'Edited')

  await adapter.deleteComment?.(ctx, site, { externalId: '5100' })
  assert.equal((calls[6]?.input as SourceFetchInput).method, 'DELETE')
})

test('fetchAsset streams through the gateway with redirect=false; anything else is not dialled', async () => {
  const { transport, calls } = recorded([
    () => ({ status: 200, stream: Readable.from([Buffer.from('log')]), contentType: 'text/plain', sizeBytes: 3 }),
  ])
  const adapter = adapterWith(transport)
  const url = 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/content/777'
  const asset = await adapter.fetchAsset?.(ctx, { url })
  assert.equal(asset?.contentType, 'text/plain')
  assert.equal(calls[0]?.input.url, `${url}?redirect=false`)
  assert.equal(calls[0]?.input.headers?.authorization, 'Bearer jira-token')
  assert.equal(await adapter.fetchAsset?.(ctx, { url: 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself' }), null)
  assert.equal(calls.length, 1)
})
