// An organisation, a space, a spreadsheet and two people who can both edit it.
//
// Everything is created through the routes a person's clicks call, except the
// two extra accounts: there is no "add a colleague" route on a local install
// without an identity provider (UOA owns invitations), so they are written
// straight into the database and then sign in through the ordinary session
// route. That is the same shape `admin/e2e/navigation/lib/seed.mjs` uses.
import { randomBytes, scrypt as nodeScrypt } from 'node:crypto'
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
export const createSpreadsheet = async (input) =>
  call(`/api/knowledge-base/spaces/${input.spaceId}/spreadsheets`, {
    body: { title: input.title },
    method: 'POST',
    token: input.token,
  })

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
