import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const API = process.env.NESSIE_API ?? 'http://localhost:5554'
const OWNER_EMAIL = 'owner@example.com'
const OWNER_PASSWORD = 'Password123!'

type Persona = {
  slug: string
  email: string
  displayName: string
  department?: string
  role: string
}

type Personas = {
  company: string
  boss: Persona
  observer: Persona
  employees: Persona[]
}

type CreatedUser = {
  slug: string
  email: string
  displayName: string
  password: string
  role: string
  department?: string
  userId?: string
  status: 'created' | 'exists' | 'failed'
  error?: string
}

const personas: Personas = JSON.parse(
  readFileSync(resolve(__dirname, 'personas.json'), 'utf8'),
) as Personas

const randomPassword = (): string =>
  `Sim-${randomBytes(8).toString('base64url')}-${randomBytes(4).toString('hex')}`

const login = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${API}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { data: { token: string } }
  return body.data.token
}

const createUser = async (
  token: string,
  persona: Persona,
  password: string,
  role: 'owner' | 'member' = 'member',
): Promise<CreatedUser> => {
  const res = await fetch(`${API}/api/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      email: persona.email,
      displayName: persona.displayName,
      password,
      role,
    }),
  })

  if (res.status === 201) {
    const body = (await res.json()) as { data: { id: string } }
    return {
      slug: persona.slug,
      email: persona.email,
      displayName: persona.displayName,
      department: persona.department,
      role: persona.role,
      password,
      userId: body.data.id,
      status: 'created',
    }
  }

  if (res.status === 409) {
    return {
      slug: persona.slug,
      email: persona.email,
      displayName: persona.displayName,
      department: persona.department,
      role: persona.role,
      password,
      status: 'exists',
    }
  }

  return {
    slug: persona.slug,
    email: persona.email,
    displayName: persona.displayName,
    department: persona.department,
    role: persona.role,
    password,
    status: 'failed',
    error: `${res.status} ${await res.text()}`,
  }
}

const main = async (): Promise<void> => {
  const stateDir = resolve(__dirname, 'state')
  mkdirSync(stateDir, { recursive: true })

  const credentialsPath = resolve(stateDir, 'credentials.json')
  const previous: Record<string, CreatedUser> = existsSync(credentialsPath)
    ? (JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, CreatedUser>)
    : {}

  console.log(`[bootstrap] logging in as ${OWNER_EMAIL}`)
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD)

  const ledger: Record<string, CreatedUser> = { ...previous }

  const personasToCreate: { persona: Persona; isBoss: boolean }[] = [
    { persona: personas.boss, isBoss: true },
    { persona: personas.observer, isBoss: false },
    ...personas.employees.map((employee) => ({ persona: employee, isBoss: false })),
  ]

  for (const { persona, isBoss } of personasToCreate) {
    const existing = ledger[persona.slug]
    const password = existing?.password ?? randomPassword()
    const result = await createUser(ownerToken, persona, password, isBoss ? 'owner' : 'member')
    ledger[persona.slug] = result
    console.log(`[bootstrap] ${persona.slug.padEnd(20)} -> ${result.status}${result.error ? ' ' + result.error : ''}`)
  }

  writeFileSync(credentialsPath, JSON.stringify(ledger, null, 2))
  console.log(`[bootstrap] wrote ${credentialsPath}`)

  const personasReady = Object.values(ledger).filter(
    (entry) => entry.status === 'created' || entry.status === 'exists',
  )
  console.log(`[bootstrap] personas ready: ${personasReady.length}/${personasToCreate.length}`)
}

await main()
