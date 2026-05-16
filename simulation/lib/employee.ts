import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { writeLedger } from './ledger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ADMIN_URL = process.env.NESSIE_ADMIN_URL ?? 'http://localhost:5555'
export const API_URL = process.env.NESSIE_API ?? 'http://localhost:5554'

type CredentialEntry = {
  slug: string
  email: string
  displayName: string
  password: string
  status: string
  userId?: string
  role: string
  department?: string
}

export type EmployeeSession = {
  slug: string
  email: string
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

const credentialsPath = resolve(__dirname, '../state/credentials.json')

const loadCredentials = (): Record<string, CredentialEntry> => {
  if (!existsSync(credentialsPath)) {
    throw new Error(`credentials.json missing — run bootstrap.ts first`)
  }
  return JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, CredentialEntry>
}

export const getCredentials = (slug: string): CredentialEntry => {
  const entry = loadCredentials()[slug]
  if (!entry) {
    throw new Error(`no credentials for slug=${slug}`)
  }
  return entry
}

export const allEmployees = (): CredentialEntry[] => Object.values(loadCredentials())

const profileDir = (slug: string): string => {
  const dir = resolve(__dirname, '../state/profiles', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const screenshotDir = (slug: string): string => {
  const dir = resolve(__dirname, '../state/screenshots', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const launchEmployee = async (slug: string): Promise<EmployeeSession> => {
  const credentials = getCredentials(slug)
  const userDataDir = profileDir(slug)

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  })

  const page = context.pages()[0] ?? (await context.newPage())

  return {
    slug,
    email: credentials.email,
    context,
    page,
    close: async () => {
      await context.close()
    },
  }
}

export const ensureLoggedIn = async (session: EmployeeSession): Promise<void> => {
  const credentials = getCredentials(session.slug)
  await session.page.goto(`${ADMIN_URL}/`, { waitUntil: 'domcontentloaded' })

  // If we're already authed the SPA redirects away from /login.
  await session.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  const currentUrl = session.page.url()
  if (!currentUrl.includes('/login')) {
    writeLedger(session.slug, 'login.skip', 'ok', `session restored at ${currentUrl}`)
    return
  }

  await session.page.fill('input[type="email"]', credentials.email)
  await session.page.fill('input[type="password"]', credentials.password)
  await Promise.all([
    session.page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 }),
    session.page.click('button[type="submit"]'),
  ])
  writeLedger(session.slug, 'login.form', 'ok', `landed at ${session.page.url()}`)
}
