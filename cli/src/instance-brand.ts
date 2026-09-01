import { loadConfig } from '@nessie/config'
import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'

/**
 * Instance-level login branding.
 *
 * The unauthenticated sign-in screen (`GET /api/brand/logo`) is instance state:
 * it is shown to everybody reaching the deployment, whatever organisation they
 * belong to. Which organisation's mark it carries is therefore an instance
 * operator's decision, not an org admin's — the same reasoning, and the same
 * out-of-band CLI, as `User.superAdmin` in `super-admin.ts`. Deliberately no
 * API/UI surface: an org admin who could set it would be choosing the login
 * screen for every other tenant on the instance.
 *
 * At most one organisation is designated; setting one clears the rest in the
 * same transaction. None designated = the static Nessie mark.
 */

const COMMANDS = [
  'set-instance-brand',
  'clear-instance-brand',
  'show-instance-brand',
] as const

type InstanceBrandCommand = typeof COMMANDS[number]
type PrismaClient = ReturnType<typeof getPrismaClient>

export const instanceBrandHelpLines = [
  'nessie set-instance-brand <organizationId>',
  'nessie clear-instance-brand',
  'nessie show-instance-brand',
]

export const isInstanceBrandCommand = (
  command: string | undefined,
): command is InstanceBrandCommand =>
  typeof command === 'string' && (COMMANDS as readonly string[]).includes(command)

const createPrismaClient = (): PrismaClient => {
  const config = loadConfig()
  const databaseUrl = process.env.DATABASE_URL ?? config.database.url
  process.env.DATABASE_URL = databaseUrl

  return getPrismaClient({
    connectionLimit: config.database.poolMax,
    log: config.mode === 'local' ? ['warn', 'error'] : ['error'],
  })
}

// `Organization.id` is a `uuid` column, so a non-UUID argument would surface as
// a Prisma "invalid character" dump rather than an answer to what the operator
// typed. Checked here, before the query.
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const requireOrganizationId = (args: string[], usage: string): string => {
  const [organizationId, ...extra] = args
  if (!organizationId || extra.length > 0) {
    throw new Error(`Usage: ${usage}`)
  }
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error(`"${organizationId}" is not an organisation id (expected a UUID).`)
  }

  return organizationId
}

const setInstanceBrand = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> => {
  const organization = await prisma.organization.findUnique({
    select: { id: true, logoAttachmentId: true, name: true },
    where: { id: organizationId },
  })

  if (!organization) {
    throw new Error(`No organisation found with id ${organizationId}.`)
  }

  await prisma.$transaction([
    prisma.organization.updateMany({
      data: { instanceBrand: false },
      where: { id: { not: organization.id }, instanceBrand: true },
    }),
    prisma.organization.update({
      data: { instanceBrand: true },
      where: { id: organization.id },
    }),
  ])

  console.log(`Sign-in screen now uses ${organization.name} (${organization.id}).`)
  if (!organization.logoAttachmentId) {
    console.log(
      'That organisation has no logo uploaded yet, so the sign-in screen keeps the Nessie mark until it does.',
    )
  }
}

const clearInstanceBrand = async (prisma: PrismaClient): Promise<void> => {
  const cleared = await prisma.organization.updateMany({
    data: { instanceBrand: false },
    where: { instanceBrand: true },
  })

  console.log(
    cleared.count > 0
      ? 'Sign-in screen reset to the Nessie mark.'
      : 'No organisation was branding the sign-in screen.',
  )
}

const showInstanceBrand = async (prisma: PrismaClient): Promise<void> => {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, logoAttachmentId: true, name: true },
    where: { instanceBrand: true },
  })

  if (organizations.length === 0) {
    console.log('No organisation is branding the sign-in screen (Nessie mark).')
    return
  }

  for (const organization of organizations) {
    const logo = organization.logoAttachmentId ? 'logo set' : 'no logo uploaded'
    console.log(`${organization.name} (${organization.id}) — ${logo}`)
  }
}

export const runInstanceBrandCommand = async (
  command: InstanceBrandCommand,
  args: string[],
): Promise<void> => {
  const prisma = createPrismaClient()
  try {
    switch (command) {
      case 'set-instance-brand':
        await setInstanceBrand(
          prisma,
          requireOrganizationId(args, 'nessie set-instance-brand <organizationId>'),
        )
        return
      case 'clear-instance-brand':
        if (args.length > 0) {
          throw new Error('Usage: nessie clear-instance-brand')
        }
        await clearInstanceBrand(prisma)
        return
      case 'show-instance-brand':
        if (args.length > 0) {
          throw new Error('Usage: nessie show-instance-brand')
        }
        await showInstanceBrand(prisma)
        return
    }
  } finally {
    await disconnectPrismaClient()
  }
}
