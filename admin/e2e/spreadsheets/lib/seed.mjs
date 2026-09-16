// An organisation, a space, a spreadsheet and two people who can both edit it.
//
// Everything is created through the routes a person's clicks call, except the
// two extra accounts: there is no "add a colleague" route on a local install
// without an identity provider (UOA owns invitations), so they are written
// straight into the database and then sign in through the ordinary session
// route. That is the same shape `admin/e2e/navigation/lib/seed.mjs` uses.
import { randomBytes, randomUUID, scrypt as nodeScrypt } from 'node:crypto'
import { promisify } from 'node:util'

import { PrismaClient } from '@prisma/client'

import { API_URL } from '../../navigation/lib/config.mjs'
import { readBootstrapToken } from '../../navigation/lib/servers.mjs'

const scrypt = promisify(nodeScrypt)

export const call = async (path, { body, method = 'GET', token } = {}) => {
  const response = await fetch(`${API_URL}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text).data : null
}

export const raw = async (path, token) => {
  const response = await fetch(`${API_URL}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.text()
}

const signInOwner = async (apiServer) => {
  const bootstrapToken = readBootstrapToken(apiServer)
  if (bootstrapToken) {
    const result = await call('/api/auth/bootstrap', {
      body: {
        bootstrapToken,
        displayName: 'Spreadsheets E2E Owner',
        email: 'spreadsheets-e2e@example.com',
        password: 'spreadsheets-e2e-password',
      },
      method: 'POST',
    })
    return result.token
  }
  return (await call('/api/auth/dev-login')).token
}

const passwordHash = async (password) => {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${(await scrypt(password, salt, 64)).toString('hex')}`
}

/**
 * Two colleagues in the owner's organisation.
 *
 * `member`, not `admin`: the two-browser proof is worth nothing if it only
 * holds for people with elevated rights, and the project's own rule is that
 * every member of a space edits it on equal terms.
 */
const addColleagues = async ({ organizationId, people, projectId }) => {
  const prisma = new PrismaClient()
  try {
    const created = []
    for (const person of people) {
      const existing = await prisma.user.findUnique({ where: { email: person.email } })
      const user = existing ?? await prisma.user.create({
        data: {
          displayName: person.displayName,
          email: person.email,
          passwordHash: await passwordHash(person.password),
        },
      })
      const membership = await prisma.organizationMember.findFirst({
        where: { organizationId, userId: user.id },
      })
      if (!membership) {
        await prisma.organizationMember.create({
          data: { organizationId, role: 'member', userId: user.id },
        })
      }
      // A knowledge space is always project-scoped, so project membership is
      // what actually decides whether these two can open the workbook at all.
      const inProject = await prisma.projectMember.findFirst({ where: { projectId, userId: user.id } })
      if (!inProject) {
        await prisma.projectMember.create({ data: { projectId, role: 'member', userId: user.id } })
      }
      created.push({ ...person, id: user.id })
    }
    return created
  } finally {
    await prisma.$disconnect()
  }
}

const signIn = async (person) => {
  const result = await call('/api/auth/session', {
    body: { email: person.email, password: person.password, providerId: 'local' },
    method: 'POST',
  })
  return result.token
}

export const PEOPLE = [
  {
    displayName: 'Ada Sheets',
    email: 'spreadsheets-e2e-a@example.com',
    password: 'spreadsheets-e2e-a-password',
  },
  {
    displayName: 'Bruno Cells',
    email: 'spreadsheets-e2e-b@example.com',
    password: 'spreadsheets-e2e-b-password',
  },
]

/**
 * A fresh spreadsheet per case run.
 *
 * Fresh rather than shared: `seq` is per page and the ordering rules are all
 * about it, so a case that inherited another's journal would be asserting
 * against numbers it did not choose.
 */
export const createSpreadsheet = async (input) => {
  const page = await call(`/api/knowledge-base/spaces/${input.spaceId}/spreadsheets`, {
    body: { title: input.title },
    method: 'POST',
    token: input.token,
  })
  if (input.rows?.length) await seedRows({ ...input, pageId: page.id })
  return { ...page, pageId: page.id }
}

/**
 * Cells in a brand-new workbook, without a browser.
 *
 * There is no "write these values" route — every write is engine diff bytes
 * through the one write door, which is the point of the design. So the harness
 * builds them the way any other client does: load the bootstrap snapshot into
 * the **Node** binding, type into it, and post what its send queue produces.
 * Spike A proved the pinned pair converges, so bytes from `@ironcalc/nodejs`
 * 0.8.3 apply in the browser's `@ironcalc/wasm` 0.8.4.
 *
 * It is worth the forty lines: a case that has to type its fixture through the
 * UI is a case whose setup can fail for reasons that have nothing to do with
 * what it is testing.
 */
const seedRows = async (input) => {
  const { loadNodeModel } = await import('@nessie/spreadsheet/node')
  const bootstrap = await call(
    `/api/knowledge-base/pages/${input.pageId}/spreadsheet`,
    { token: input.token },
  )
  const model = loadNodeModel(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
  for (const batch of bootstrap.batches) {
    if (batch.diffs) model.applyExternalDiffs(Buffer.from(batch.diffs, 'base64'))
  }
  model.flushSendQueue()

  const intents = []
  model.pauseEvaluation()
  input.rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === null || value === undefined || value === '') return
      const at = { row: rowIndex + 1, column: columnIndex + 1 }
      model.setUserInput(0, at.row, at.column, String(value))
      intents.push({ kind: 'setUserInput', sheet: 0, ...at, value: String(value) })
    })
  })
  model.resumeEvaluation()
  model.evaluate()

  const diffs = Buffer.from(model.flushSendQueue())
  if (diffs.byteLength <= 1) return
  await call(`/api/knowledge-base/pages/${input.pageId}/spreadsheet/ops`, {
    body: {
      clientOpId: randomUUID(),
      baseSeq: bootstrap.headSeq,
      diffs: diffs.toString('base64'),
      summary: {
        structuralKind: null,
        sheetIndexes: [0],
        cellCount: intents.length,
        touched: intents.map((intent) => ({
          sheet: 0, r0: intent.row, c0: intent.column, r1: intent.row, c1: intent.column,
        })),
        intents,
      },
    },
    method: 'POST',
    token: input.token,
  })
}

/**
 * A file node in the space, from bytes this process makes.
 *
 * Used by the doorway case to stand up the two things "Open as spreadsheet"
 * has to tell apart: an `.xlsx` the engine can read, and an `.xls` it cannot.
 * The `.xls` bytes are only its OLE2 magic — nothing ever opens them, and the
 * whole point is that the doorway refuses before anything tries.
 */
export const uploadFileNode = async ({ bytes, filename, mime, spaceId, token }) => {
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: mime }), filename)
  const response = await fetch(`${API_URL}/api/knowledge-base/spaces/${spaceId}/files`, {
    body: form,
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`upload ${filename} → ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text).data
}

/**
 * Real `.xlsx` bytes: a seeded spreadsheet, exported through the route the
 * Export button calls. Genuine rather than synthesised, so "Open as
 * spreadsheet" is asked to read a file the engine actually wrote.
 */
export const serverXlsx = async (pageId, token) => {
  const response = await fetch(
    `${API_URL}/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=xlsx`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!response.ok) throw new Error(`export xlsx → ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** The OLE2 header, and nothing else: an `.xls` in every way that matters here. */
export const legacyXlsBytes = () =>
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])

/** The workbook as the server holds it — the oracle every case checks against,
 *  because a value read back out of the browser that wrote it proves nothing. */
export const serverCsv = async (pageId, token) =>
  raw(`/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=csv&sheet=0`, token)

export const seedOrganisation = async (apiServer) => {
  const ownerToken = await signInOwner(apiServer)
  const me = await call('/api/auth/me', { token: ownerToken })
  const organizationId = me.context.organizationId
  const projects = await call('/api/projects', { token: ownerToken })
  const project = projects[0]
  if (!project) throw new Error('the bootstrapped organisation has no project to hold a space')
  const space = await call('/api/knowledge-base/spaces', {
    body: { name: `Spreadsheets E2E ${Date.now()}`, projectId: project.id },
    method: 'POST',
    token: ownerToken,
  })
  const people = await addColleagues({ organizationId, people: PEOPLE, projectId: project.id })
  const tokens = []
  for (const person of people) tokens.push({ ...person, token: await signIn(person) })
  return { organizationId, ownerToken, people: tokens, projectId: project.id, spaceId: space.id }
}
