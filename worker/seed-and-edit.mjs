// Verification driver for delta editing: creates a real .md document node,
// then drives the recorder's edit mode with provider-shaped fragments so the
// whole chain (edit scanner -> tracker -> lanes -> SSE) runs for real.
import { PrismaClient } from '@prisma/client'
import { Readable } from 'node:stream'
import pg from 'pg'
import { PgRealtimeTransport, createFileService, getStorage } from '@nessie/runtime'
import { loadConfig } from '@nessie/config'
import { createDocumentStreamRecorder } from './dist/run/execute/document-stream.js'
import { readMarkdownDocument } from './dist/run/pa-tools/knowledge-document-io.js'

const {
  DATABASE_URL, THREAD_ID, RUN_ID, AGENT_ID, ORG_ID, SPACE_ID, PROJECT_ID,
} = process.env

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
const pool = new pg.Pool({ connectionString: DATABASE_URL })
const transport = new PgRealtimeTransport(pool, DATABASE_URL)
const config = loadConfig()
const fileService = createFileService({
  prisma,
  storage: getStorage(config.storage),
  maxUploadBytes: config.storage.maxUploadBytes,
})

const BASE = `# Team Handbook

## Section 1: policy area 1

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 1 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 2: policy area 2

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 2 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 3: policy area 3

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 3 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 4: policy area 4

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 4 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 5: policy area 5

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 5 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 6: policy area 6

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 6 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 7: policy area 7

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 7 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 8: policy area 8

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 8 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 9: policy area 9

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 9 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 10: policy area 10

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 10 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 11: policy area 11

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 11 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Section 12: policy area 12

This paragraph exists so the handbook is long enough to scroll. It describes
policy area 12 in enough words to occupy a few lines of the rendered page, so
that the position of a change within the document is visually meaningful.

## Deployment

We deploy on Fridays, which has never once caused a problem.

## Section 13: policy area 13

Further prose for policy area 13, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 14: policy area 14

Further prose for policy area 14, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 15: policy area 15

Further prose for policy area 15, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 16: policy area 16

Further prose for policy area 16, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 17: policy area 17

Further prose for policy area 17, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 18: policy area 18

Further prose for policy area 18, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 19: policy area 19

Further prose for policy area 19, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 20: policy area 20

Further prose for policy area 20, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 21: policy area 21

Further prose for policy area 21, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 22: policy area 22

Further prose for policy area 22, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 23: policy area 23

Further prose for policy area 23, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Section 24: policy area 24

Further prose for policy area 24, again long enough to take up vertical space
in the rendered document so the viewport has somewhere to scroll to.

## Support rota

One person is on call each week.

## Onboarding

New joiners get a buddy for their first month.
`

const attribution = {
  actorId: AGENT_ID, actorType: 'agent',
  organizationId: ORG_ID, projectId: PROJECT_ID, teamId: null,
  userId: null, agentId: AGENT_ID, runId: RUN_ID,
}

let pageId = process.env.PAGE_ID
if (!pageId) {
  const { attachment } = await fileService.store({
    attribution,
    body: Readable.from([Buffer.from(BASE, 'utf8')]),
    filename: 'Team Handbook.md',
    mime: 'text/markdown',
    organizationId: ORG_ID,
    scope: { projectId: PROJECT_ID, spaceId: SPACE_ID, teamId: null },
    uploaderId: null,
  })
  const page = await prisma.knowledgePage.create({
    data: {
      createdBy: AGENT_ID, kind: 'file', organizationId: ORG_ID,
      projectId: PROJECT_ID, spaceId: SPACE_ID, status: 'published',
      title: 'Team Handbook.md', visibility: 'project',
    },
    select: { id: true },
  })
  await prisma.knowledgePageVersion.create({
    data: {
      attachmentId: attachment.id, authorId: AGENT_ID, authorType: 'agent',
      pageId: page.id, versionNumber: 1,
    },
  })
  pageId = page.id
  console.log('created document pageId=', pageId)
}

const loaded = await readMarkdownDocument(prisma, fileService, ORG_ID, pageId)
console.log('base document length:', loaded?.content.length)

const recorder = createDocumentStreamRecorder({
  loadDocument: async (id) => readMarkdownDocument(prisma, fileService, ORG_ID, id),
  prisma,
  realtimeTransport: transport,
  run: { agentId: AGENT_ID, id: RUN_ID, organizationId: ORG_ID, threadId: THREAD_ID },
})

const args = JSON.stringify({
  pageId,
  changeComment: 'tighten policies',
  edits: [
    {
      find: 'We deploy on Fridays, which has never once caused a problem.',
      replace:
        'We deploy Monday through Thursday. Friday deploys need a second pair of eyes '
        + 'and a rollback plan written down before you start.',
    },
    {
      find: 'One person is on call each week.',
      replace: 'Two people share each on-call week: a primary and a backup. 🎯',
    },
  ],
})

const INVOCATION = `inv-${Date.now()}`
const TOOL_CALL = `call-${Date.now()}`
recorder.beginInvocation(INVOCATION)
const sizes = [9, 3, 17, 2, 29, 5, 13, 41, 7]
let cursor = 0
let i = 0
while (cursor < args.length) {
  const size = sizes[i % sizes.length]
  recorder.handleToolCallDelta({
    id: TOOL_CALL,
    index: 0,
    invocationId: INVOCATION,
    text: args.slice(cursor, cursor + size),
    toolName: 'kb_document_edit',
  })
  cursor += size
  i += 1
  await new Promise((r) => setTimeout(r, Number(process.env.FRAGMENT_DELAY_MS ?? 90)))
}

const handle = await recorder.settle(TOOL_CALL)
console.log('settled sessionId=', handle?.sessionId, 'length=', handle?.markdown.length)
console.log('deploy line replaced:', handle?.markdown.includes('Monday through Thursday'))
console.log('rota line replaced:', handle?.markdown.includes('primary and a backup'))
console.log('untouched section intact:', handle?.markdown.includes('New joiners get a buddy'))

await new Promise((r) => setTimeout(r, 600))
await recorder.close()
await transport.close()
await pool.end()
await prisma.$disconnect()
