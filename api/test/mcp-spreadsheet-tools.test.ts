import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  createNativeKnowledgeProvider,
  createSpreadsheetService,
  type SpreadsheetServiceDeps,
} from '@nessie/knowledge'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import { buildNessieMcpServer, nessieMcpTools } from '../src/mcp/server.js'
import type { McpToolContext } from '../src/mcp/tool-context.js'

// The MCP mirror, against a real database and a real IronCalc model.
//
// Three properties are worth a database to pin, and each one is a way the
// mirror could have quietly stopped being a mirror:
//
//  - a credential without `documents_write` is refused BEFORE anything reads a
//    page, a space or a batch summary. The summary is advisory; if a scope
//    check ever ended up downstream of it, a caller would be describing its own
//    change to the thing deciding whether it may make it;
//  - a write through a credential is stamped `via: 'mcp_agent_credential'`, so
//    the history can tell a person's own edit from one their agent made as them;
//  - `requestId` is honoured, so a paired agent that retries does not double-
//    apply. (Retrying *without* one does, and the description says so.)

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const tool = (name: string) => {
  const found = nessieMcpTools().find((candidate) => candidate.name === name)
  assert.ok(found, `${name} is not registered`)
  return found
}

type Seed = {
  organizationId: string
  projectId: string
  spaceId: string
  userId: string
  credentialId: string
  service: SpreadsheetServiceDeps
  prisma: PrismaClient
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mcp-sheet ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const user = await prisma.user.create({
    data: { displayName: 'Mira', email: `mcp-sheet-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: org.id, role: 'owner', userId: user.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: 'Models',
      organizationId: org.id,
      projectId: project.id,
      visibility: 'organization',
    },
  })
  const provider = createNativeKnowledgeProvider(prisma, {})
  // Deliberately no `publish` and no `enqueueCompaction`: the MCP endpoint's
  // own wiring hands in the process transport, and neither is what this suite
  // is about.
  const service = createSpreadsheetService({
    prisma,
    fileService: {} as never,
    createPage: (input) => provider.createPage(input),
    addFileVersion: (input) => provider.addFileVersion(input),
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    spaceId: space.id,
    userId: user.id,
    credentialId: randomUUID(),
    service,
    prisma,
  }
}

const contextFor = (s: Seed, overrides: Partial<McpToolContext> = {}): McpToolContext => ({
  actorContext: AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID(), agentCredentialId: s.credentialId },
    actor: { actorId: s.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: s.organizationId, projectId: s.projectId },
  }),
  encryptionKeyRing: { activeVersion: 'test', keys: { test: 'mcp-spreadsheet-root' } },
  checkPolicy: async () => ({ allowed: true, reasonCode: 'ALLOWED' }),
  getTask: async () => null,
  isProjectAccessibleToActor: async () => true,
  knowledge: {
    buildDisclosureViewer: () => null,
    buildViewer: async () => ({
      bypass: true,
      userId: s.userId,
      visibleAgentIds: new Set<string>(),
    }) as never,
    filterReadablePages: async (_viewer, pages) => [...pages],
    provider: createNativeKnowledgeProvider(s.prisma, {}),
  },
  prisma: s.prisma,
  scopes: ['documents_read', 'documents_write'],
  spreadsheet: s.service,
  ...overrides,
})

const cleanup = async (s: Seed): Promise<void> => {
  await s.prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => undefined)
  await s.prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
}

runDatabaseTest('every builtin sheet tool has a mirror, and only sheet mirrors exist', () => {
  const mirrors = nessieMcpTools()
    .map((definition) => definition.name)
    .filter((name) => name.startsWith('nessie_sheet_'))
    .sort()
  assert.deepEqual(mirrors, [
    'nessie_sheet_create',
    'nessie_sheet_describe',
    'nessie_sheet_export',
    'nessie_sheet_filter',
    'nessie_sheet_find',
    'nessie_sheet_format_range',
    'nessie_sheet_read_range',
    'nessie_sheet_replace',
    'nessie_sheet_structure',
    'nessie_sheet_tabs',
    'nessie_sheet_versions',
    'nessie_sheet_write_range',
  ])
})

runDatabaseTest('the server registers the mirror and hands it the shared service', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // Building the server is what proves the spread in `nessieMcpTools` reaches
    // the SDK: a tool defined but never registered answers nothing.
    const server = buildNessieMcpServer(contextFor(s))
    assert.ok(server)
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent creates a spreadsheet, writes into it and reads it back', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(s)
    const created = await tool('nessie_sheet_create').run(context, {
      spaceId: s.spaceId,
      title: 'Runway',
      sheets: [{ name: 'Model', rows: [['Month', 'Spend'], ['Jan', 1000]] }],
    }) as { error?: string; pageId?: string; sheets?: string[] }
    assert.equal(created.error, undefined, `create failed: ${created.error}`)
    assert.deepEqual(created.sheets, ['Model'])

    const pageId = created.pageId as string
    const written = await tool('nessie_sheet_write_range').run(context, {
      pageId,
      sheet: 'Model',
      range: 'A3',
      rows: [['Feb', 1500], ['Total', '=SUM(B2:B3)']],
      requestId: 'write-once',
    }) as { error?: string; outcome?: { seq: number } }
    assert.equal(written.error, undefined, `write failed: ${written.error}`)

    const read = await tool('nessie_sheet_read_range').run(context, {
      pageId,
      sheet: 'Model',
      range: 'A1:B4',
    }) as { rows: string[][] }
    assert.deepEqual(read.rows[3], ['Total', '2500'])

    const described = await tool('nessie_sheet_describe').run(context, { pageId }) as {
      sheets: { name: string; usedRange: string | null }[]
    }
    assert.equal(described.sheets[0]?.name, 'Model')
    assert.equal(described.sheets[0]?.usedRange, 'A1:B4')
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a read-only credential is refused before any summary is read', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const owner = contextFor(s)
    const created = await tool('nessie_sheet_create').run(owner, {
      spaceId: s.spaceId,
      title: 'Read only',
    }) as { pageId: string }

    const reader = contextFor(s, { scopes: ['documents_read'] })
    // A page id that does not exist. If the scope check had run after the page
    // lookup, this would come back "not found" — which is exactly the wrong
    // answer, because it would mean the credential's reach was being probed
    // before its grant was checked.
    const refused = await tool('nessie_sheet_write_range').run(reader, {
      pageId: randomUUID(),
      range: 'A1',
      rows: [['x']],
    }).catch((error: unknown) => error)
    assert.ok(refused instanceof Error, 'a missing scope should refuse, not answer')
    assert.match(refused.message, /documents_write/)

    // And it can still read.
    const read = await tool('nessie_sheet_describe').run(reader, {
      pageId: created.pageId,
    }) as { error?: string; title?: string }
    assert.equal(read.error, undefined)
    assert.equal(read.title, 'Read only')

    // Nothing landed on the page the reader named.
    const batches = await prisma.spreadsheetOpBatch.count({ where: { pageId: created.pageId } })
    const afterRefusal = await prisma.spreadsheetOpBatch.count({ where: { pageId: created.pageId } })
    assert.equal(batches, afterRefusal)
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a write through a credential is stamped `via: mcp_agent_credential`', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(s)
    const created = await tool('nessie_sheet_create').run(context, {
      spaceId: s.spaceId,
      title: 'Audited',
    }) as { pageId: string }

    await tool('nessie_sheet_write_range').run(context, {
      pageId: created.pageId,
      range: 'A1',
      rows: [['audited']],
      requestId: 'audited-write',
    })

    const entries = await prisma.auditLog.findMany({
      where: { resourceId: created.pageId, organizationId: s.organizationId },
      select: { action: true, metadata: true },
    })
    const stamped = entries.filter(
      (entry) => (entry.metadata as { via?: string } | null)?.via === 'mcp_agent_credential',
    )
    assert.ok(stamped.length >= 2, 'both the create and the write should be stamped')
    assert.ok(stamped.some((entry) => entry.action === 'kb.page.created'))
    assert.ok(stamped.some((entry) => entry.action === 'kb.page.updated'))

    // The journal records the human the credential borrows, with the
    // credential beside them — without which the two are indistinguishable.
    const batch = await prisma.spreadsheetOpBatch.findFirst({
      where: { pageId: created.pageId },
      orderBy: { seq: 'desc' },
      select: { actorType: true, actorId: true, agentCredentialId: true },
    })
    assert.equal(batch?.actorType, 'user')
    assert.equal(batch?.actorId, s.userId)
    assert.equal(batch?.agentCredentialId, s.credentialId)
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a retried write with the same requestId is answered, not applied twice', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(s)
    const created = await tool('nessie_sheet_create').run(context, {
      spaceId: s.spaceId,
      title: 'Idempotent',
    }) as { pageId: string }

    const args = {
      pageId: created.pageId,
      range: 'A1',
      rows: [['first']],
      requestId: 'retry-me',
    }
    const first = await tool('nessie_sheet_write_range').run(context, args) as {
      outcome: { seq: number; replayed: boolean }
    }
    const retried = await tool('nessie_sheet_write_range').run(context, {
      ...args,
      rows: [['second']],
    }) as { outcome: { seq: number; replayed: boolean } }

    assert.equal(retried.outcome.seq, first.outcome.seq)
    assert.equal(retried.outcome.replayed, true)
    const read = await tool('nessie_sheet_read_range').run(context, {
      pageId: created.pageId,
      range: 'A1',
    }) as { rows: string[][] }
    assert.deepEqual(read.rows, [['first']])
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a spreadsheet the credential cannot reach answers the same as one that is missing', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(s, {
      knowledge: {
        buildDisclosureViewer: () => null,
        buildViewer: async () => ({
          bypass: true,
          userId: s.userId,
          visibleAgentIds: new Set<string>(),
        }) as never,
        // The version half of the rule says no.
        filterReadablePages: async () => [],
        provider: createNativeKnowledgeProvider(prisma, {}),
      },
    })
    const owner = contextFor(s)
    const created = await tool('nessie_sheet_create').run(owner, {
      spaceId: s.spaceId,
      title: 'Hidden',
    }) as { pageId: string }

    const unreachable = await tool('nessie_sheet_describe').run(context, {
      pageId: created.pageId,
    }) as { error?: string }
    const missing = await tool('nessie_sheet_describe').run(context, {
      pageId: randomUUID(),
    }) as { error?: string }
    // Which it was is not something to learn by walking ids.
    assert.equal(unreachable.error, missing.error)
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the engine\'s own refusal is returned verbatim, not flattened', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const context = contextFor(s)
    const created = await tool('nessie_sheet_create').run(context, {
      spaceId: s.spaceId,
      title: 'One sheet',
    }) as { pageId: string }

    const refused = await tool('nessie_sheet_tabs').run(context, {
      pageId: created.pageId,
      action: 'delete',
      name: 'Sheet1',
      requestId: 'delete-last',
    }) as { error?: string; reason?: string }
    // The engine's own words, carried through rather than paraphrased: "a
    // workbook must keep at least one sheet" is better advice than any
    // restatement of it, and the plan's failure table puts it in `reason`.
    assert.equal(refused.error, 'The spreadsheet engine refused this change')
    assert.match(String(refused.reason), /at least one sheet/)
  } finally {
    await cleanup(s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a credential reaches a shared spreadsheet exactly as far as the share', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const grantee = await prisma.user.create({
    data: { displayName: 'Ravi', email: `mcp-sheet-grantee-${randomUUID()}@example.test` },
  })
  try {
    await prisma.organizationMember.create({
      data: { organizationId: s.organizationId, role: 'member', userId: grantee.id },
    })
    // The sharer's own documents: private, so nothing but a share reaches in.
    const personal = await prisma.knowledgeSpace.create({
      data: {
        createdBy: s.userId,
        userId: s.userId,
        metadata: { personal: true },
        name: 'My Documents',
        organizationId: s.organizationId,
        projectId: s.projectId,
        visibility: 'private',
      },
    })
    const created = await tool('nessie_sheet_create').run(contextFor(s), {
      spaceId: personal.id,
      title: 'Runway',
      sheets: [{ name: 'Model', rows: [['Month', 'Spend'], ['Jan', 1000]] }],
    }) as { error?: string; pageId?: string }
    assert.equal(created.error, undefined, `create failed: ${created.error}`)
    const pageId = created.pageId as string

    // A credential resolves as the person who approved it, so the grantee's
    // context is an ordinary viewer — not the bypass one the other tests use.
    const asGrantee = contextFor(s, {
      actorContext: AuthorizedActionContextSchema.parse({
        actionContext: { requestId: randomUUID(), agentCredentialId: s.credentialId },
        actor: { actorId: grantee.id, actorType: 'user', roles: ['member'] },
        tenant: { organizationId: s.organizationId, projectId: s.projectId },
      }),
      knowledge: {
        buildDisclosureViewer: () => null,
        buildViewer: async () => ({
          baseEntitled: true,
          bypass: false,
          organizationRole: 'member',
          uoaMembershipVerified: false,
          userId: grantee.id,
          projectIds: new Set<string>(),
          visibleAgentIds: new Set<string>(),
        }) as never,
        filterReadablePages: async (_viewer, pages) => [...pages],
        provider: createNativeKnowledgeProvider(prisma, {}),
      },
    })

    const read = () => tool('nessie_sheet_read_range').run(asGrantee, {
      pageId,
      sheet: 'Model',
      range: 'A1:B2',
    }) as Promise<{ error?: string; rows?: string[][] }>
    const write = () => tool('nessie_sheet_write_range').run(asGrantee, {
      pageId,
      sheet: 'Model',
      range: 'A3',
      rows: [['Feb', 1500]],
      requestId: randomUUID(),
    }) as Promise<{ error?: string }>

    // Nothing at all without a share: the page is in somebody else's private
    // space, and a page id is never a grant.
    assert.match((await read()).error ?? '', /not one this account can use/)

    const share = await prisma.knowledgePageShare.create({
      data: {
        organizationId: s.organizationId,
        pageId,
        spaceId: personal.id,
        granteeUserId: grantee.id,
        grantedByUserId: s.userId,
        access: 'view',
      },
    })
    const viewed = await read()
    assert.equal(viewed.error, undefined, `a view share reads: ${viewed.error}`)
    assert.deepEqual(viewed.rows?.[0], ['Month', 'Spend'])
    assert.match((await write()).error ?? '', /not one this account can use/)

    await prisma.knowledgePageShare.update({ where: { id: share.id }, data: { access: 'edit' } })
    assert.equal((await write()).error, undefined, 'an edit share writes')

    // Revocation is a hard delete, so the very next call finds nothing.
    await prisma.knowledgePageShare.delete({ where: { id: share.id } })
    assert.match((await read()).error ?? '', /not one this account can use/)
  } finally {
    await cleanup(s)
    await prisma.user.delete({ where: { id: grantee.id } }).catch(() => undefined)
    await prisma.$disconnect()
  }
})
