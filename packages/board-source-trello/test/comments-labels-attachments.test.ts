import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type {
  ConnectionContext,
  SourceFetchInput,
  SourceFetchStreamInput,
  SyncCheckpoint,
} from '@nessie/board-sources'
import { itemFingerprint } from '@nessie/board-sources'

import { createTrelloAdapter } from '../src/adapter.js'
import type { TrelloTransport } from '../src/http.js'
import {
  type TrelloCard,
  type TrelloCommentAction,
  normaliseTrelloCard,
  normaliseTrelloComment,
  normaliseTrelloLabel,
} from '../src/normalise.js'
import { parseTrelloWebhook } from '../src/webhook-parse.js'

const ctx: ConnectionContext = {
  connectionId: 'connection-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  provider: 'trello',
  externalAccountId: 'member-me',
  externalTenantId: '',
  credential: { accessToken: 'trello-token', scopes: ['read', 'write'] },
}
const board = { boardId: 'board-1' }
const lists = [{ id: 'list-1', name: 'To do', pos: 1 }]
const upload = 'https://trello.com/1/cards/card-1/attachments/att-1/download/screen.png'

const card = (over: Partial<TrelloCard> = {}): TrelloCard => ({
  id: 'card-1',
  idShort: 7,
  name: 'Ship it',
  desc: `See ![screen](${upload}) and [the other card](https://trello.com/c/xyz/8-other)`,
  url: 'https://trello.com/c/abc/7-ship-it',
  closed: false,
  idList: 'list-1',
  labels: [{ id: 'label-1', name: 'bug', color: 'red' }],
  dateLastActivity: '2026-09-02T00:00:00.000Z',
  ...over,
})

const action = (over: Partial<TrelloCommentAction> = {}): TrelloCommentAction => ({
  id: 'action-1',
  type: 'commentCard',
  date: '2026-09-03T00:00:00.000Z',
  idMemberCreator: 'member-a',
  memberCreator: { id: 'member-a', fullName: 'Alice', username: 'alice' },
  data: { text: 'Looks good', card: { id: 'card-1', shortLink: 'abc' } },
  ...over,
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
  const transport: TrelloTransport = {
    json: async <T>(input: SourceFetchInput) => next({ kind: 'json', input }) as T,
    stream: async (input) =>
      next({ kind: 'stream', input }) as Awaited<ReturnType<TrelloTransport['stream']>>,
  }
  return { transport, calls }
}

const adapterWith = (transport: TrelloTransport) =>
  createTrelloAdapter({ apiKey: 'app-key', apiSecret: 'app-secret', transport })

test('a named Trello colour becomes Trello’s own hex; no colour takes the default', () => {
  assert.deepEqual(normaliseTrelloLabel({ id: 'l1', name: 'bug', color: 'red' }), {
    id: 'l1',
    label: 'bug',
    color: '#f87168',
  })
  assert.equal(normaliseTrelloLabel({ id: 'l2', name: 'x', color: 'sky_dark' }).color, '#227d9b')
  assert.deepEqual(normaliseTrelloLabel({ id: 'l3', name: 'plain', color: null }), { id: 'l3', label: 'plain' })
})

test('a colour-only label is named after its colour rather than dropped', () => {
  assert.equal(normaliseTrelloLabel({ id: 'l4', name: '', color: 'green_dark' }).label, 'Green dark')
})

test('fields.labels keeps the ids, so the fingerprint does not move on upgrade', () => {
  const item = normaliseTrelloCard(card(), new Map())
  assert.deepEqual(item.fields.labels, ['label-1'])
  assert.equal(
    itemFingerprint(item, ['labels']),
    itemFingerprint({ ...item, fields: { labels: ['label-1'] } }, ['labels']),
  )
})

test('uploads are files, attached links are links, and a card link in the text is prose', () => {
  const item = normaliseTrelloCard(
    card({
      attachments: [
        { id: 'att-1', name: 'screen.png', url: upload, bytes: 1200, mimeType: 'image/png', isUpload: true, date: '2026-09-01T00:00:00.000Z' },
        { id: 'att-2', name: 'Spec', url: 'https://docs.example/spec', isUpload: false, date: '2026-09-01T00:00:00.000Z' },
      ],
    }),
    new Map(),
  )
  const byUrl = new Map((item.attachments ?? []).map((a) => [a.url, a]))
  // Listed and pasted inline: one asset, the listed entry with Trello's id.
  assert.equal(byUrl.get(upload)?.externalId, 'att-1')
  assert.equal(byUrl.get(upload)?.kind, 'file')
  assert.equal(byUrl.get(upload)?.sizeBytes, 1200)
  assert.equal(byUrl.get('https://docs.example/spec')?.kind, 'link')
  assert.equal(byUrl.has('https://trello.com/c/xyz/8-other'), false)
  assert.equal(item.attachments?.length, 2)
  // Read without comment actions: not "no comments", but "not read".
  assert.equal(item.comments, undefined)
})

test('a comment action normalises with its author, card and edit time', () => {
  const edited = normaliseTrelloComment(
    action({ data: { text: 'Fixed', dateLastEdited: '2026-09-04T00:00:00.000Z', card: { id: 'card-1', shortLink: 'abc' } } }),
  )
  assert.deepEqual(edited.author, { externalUserId: 'member-a', displayName: 'Alice' })
  assert.equal(edited.issueExternalId, 'card-1')
  assert.equal(edited.updatedAt, '2026-09-04T00:00:00.000Z')
  assert.equal(edited.editedAt, '2026-09-04T00:00:00.000Z')
  assert.equal(edited.url, 'https://trello.com/c/abc#comment-action-1')
})

test('the card lane hands over to the comment lane, which pages backwards with before', async () => {
  const fullPage = Array.from({ length: 50 }, (_, i) => action({ id: `a-${i}` }))
  const { transport, calls } = recorded([
    () => lists,
    () => [card()],
    () => fullPage,
    () => [action({ id: 'a-last' })],
  ])
  const adapter = adapterWith(transport)
  const first = await adapter.fetchPage(ctx, board, { phase: 'initial' }, { syncWindowDays: 30 })
  assert.equal(first.items.length, 1)
  assert.equal(first.hasMore, true)
  assert.equal(first.checkpoint.lane, 'comments')
  assert.equal(first.checkpoint.commentsSince, '1970-01-01T00:00:00.000Z')
  assert.match(calls[1]?.input.url as string, /attachments=true/)

  const second = await adapter.fetchPage(ctx, board, first.checkpoint, { syncWindowDays: 30 })
  assert.equal(second.hasMore, true)
  assert.equal(second.checkpoint.commentsCursor, 'a-49')
  assert.equal(second.comments?.length, 50)
  const laneUrl = new URL(calls[2]?.input.url as string)
  assert.equal(laneUrl.pathname, '/1/boards/board-1/actions')
  assert.equal(laneUrl.searchParams.get('filter'), 'commentCard')

  const third = await adapter.fetchPage(ctx, board, second.checkpoint, { syncWindowDays: 30 })
  assert.equal(new URL(calls[3]?.input.url as string).searchParams.get('before'), 'a-49')
  assert.equal(third.hasMore, false)
  assert.equal(third.checkpoint.lane, 'items')
  // The clock moves to when the card lane ran, less a minute of overlap.
  const expected = new Date(Date.parse(first.checkpoint.since as string) - 60_000).toISOString()
  assert.equal(third.checkpoint.commentsSince, expected)
})

test('the webhook path re-reads a card with its comments and files', async () => {
  const { transport, calls } = recorded([() => lists, () => card({ actions: [action()] })])
  const [item] = await adapterWith(transport).fetchItems(ctx, board, ['card-1'])
  assert.equal(item?.comments?.[0]?.externalId, 'action-1')
  assert.match(calls[1]?.input.url as string, /actions=commentCard/)
})

test('describe lists the board’s labels and no longer declares a labels field', async () => {
  const { transport } = recorded([
    () => lists,
    () => [{ id: 'member-a', fullName: 'Alice', username: 'alice' }],
    () => [{ id: 'label-1', name: 'bug', color: 'red' }],
  ])
  const description = await adapterWith(transport).describeContainer(ctx, board)
  assert.deepEqual(description.fields, [])
  assert.deepEqual(description.labels, [{ id: 'label-1', label: 'bug', color: '#f87168' }])
})

test('webhooks: a deleted comment carries its id; a label action re-describes', () => {
  const deleted = parseTrelloWebhook({
    provider: 'trello',
    headers: {},
    rawBody: JSON.stringify({ action: { id: 'x', type: 'deleteComment', data: { action: { id: 'action-1' }, card: { id: 'card-1' }, board: { id: 'board-1' } } } }),
  })
  assert.deepEqual(deleted.externalIds, ['card-1'])
  assert.deepEqual(deleted.removedCommentExternalIds, ['action-1'])
  const label = parseTrelloWebhook({
    provider: 'trello',
    headers: {},
    rawBody: JSON.stringify({ action: { id: 'y', type: 'updateLabel', data: { board: { id: 'board-1' } } } }),
  })
  assert.equal(label.resource, 'label')
  assert.deepEqual(label.externalIds, [])
})

test('write-back: idLabels, and the three comment calls with their echoes', async () => {
  const { transport, calls } = recorded([
    () => card({ labels: [{ id: 'label-2', name: 'docs', color: 'blue' }] }),
    () => lists,
    () => action({ id: 'action-9', data: { text: 'From Nessie', card: { id: 'card-1' } } }),
    () => action({ id: 'action-9', data: { text: 'Edited', dateLastEdited: '2026-09-05T00:00:00.000Z', card: { id: 'card-1' } } }),
    () => ({ _value: null }),
  ])
  const adapter = adapterWith(transport)
  const echo = await adapter.applyChange(ctx, board, { externalId: 'card-1', externalKey: '#7' }, { labelIds: ['label-2'] })
  assert.equal(new URL(calls[0]?.input.url as string).searchParams.get('idLabels'), 'label-2')
  assert.deepEqual(echo.labels, [{ id: 'label-2', label: 'docs', color: '#579dff' }])

  const created = await adapter.createComment?.(ctx, board, { externalId: 'card-1', externalKey: '#7' }, 'From Nessie')
  assert.equal(new URL(calls[2]?.input.url as string).pathname, '/1/cards/card-1/actions/comments')
  assert.deepEqual(JSON.parse(calls[2]?.input.body as string), { text: 'From Nessie' })
  assert.deepEqual([created?.externalId, created?.issueExternalId], ['action-9', 'card-1'])

  const updated = await adapter.updateComment?.(ctx, board, { externalId: 'action-9' }, 'Edited')
  assert.equal((calls[3]?.input as SourceFetchInput).method, 'PUT')
  assert.equal(new URL(calls[3]?.input.url as string).pathname, '/1/actions/action-9')
  assert.equal(updated?.editedAt, '2026-09-05T00:00:00.000Z')

  await adapter.deleteComment?.(ctx, board, { externalId: 'action-9' })
  assert.equal((calls[4]?.input as SourceFetchInput).method, 'DELETE')
})

test('fetchAsset reads an upload from the API host with the OAuth header, never the query', async () => {
  const { transport, calls } = recorded([
    () => ({ status: 200, stream: Readable.from([Buffer.from('png')]), contentType: 'image/png', sizeBytes: 3 }),
  ])
  const adapter = adapterWith(transport)
  const asset = await adapter.fetchAsset?.(ctx, { url: upload })
  assert.equal(asset?.contentType, 'image/png')
  const url = new URL(calls[0]?.input.url as string)
  assert.equal(url.hostname, 'api.trello.com')
  assert.equal(url.search, '')
  assert.equal(
    calls[0]?.input.headers?.authorization,
    'OAuth oauth_consumer_key="app-key", oauth_token="trello-token"',
  )
  // A card page is never dialled as a file.
  assert.equal(await adapter.fetchAsset?.(ctx, { url: 'https://trello.com/c/xyz' }), null)
  assert.equal(calls.length, 1)
})

test('an incremental checkpoint from before the lanes existed starts on the card lane', async () => {
  const { transport } = recorded([() => lists, () => []])
  const legacy: SyncCheckpoint = { phase: 'incremental', since: '2026-09-01T00:00:00.000Z' }
  const page = await adapterWith(transport).fetchPage(ctx, board, legacy, { syncWindowDays: 30 })
  assert.equal(page.checkpoint.lane, 'comments')
})
