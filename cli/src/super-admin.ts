import { loadConfig } from '@nessie/config'
import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'

const COMMANDS = [
  'grant-super-admin',
  'revoke-super-admin',
  'list-super-admins',
] as const

type SuperAdminCommand = typeof COMMANDS[number]
type PrismaClient = ReturnType<typeof getPrismaClient>
type ListedSuperAdmin = {
  displayName: string
  email: string
}

export const superAdminHelpLines = [
  'nessie grant-super-admin <email>',
  'nessie revoke-super-admin <email>',
  'nessie list-super-admins',
]

export const isSuperAdminCommand = (
  command: string | undefined,
): command is SuperAdminCommand =>
  typeof command === 'string' && (COMMANDS as readonly string[]).includes(command)

const requireEmail = (args: string[], usage: string): string => {
  const [email, ...extra] = args
  if (!email || extra.length > 0) {
    throw new Error(`Usage: ${usage}`)
  }

  return email
}

const createPrismaClient = (): PrismaClient => {
  const config = loadConfig()
  const databaseUrl = process.env.DATABASE_URL ?? config.database.url
  process.env.DATABASE_URL = databaseUrl

  return getPrismaClient({
    connectionLimit: config.database.poolMax,
    log: config.mode === 'local' ? ['warn', 'error'] : ['error'],
  })
}

const formatUser = (user: ListedSuperAdmin): string =>
  user.displayName ? `${user.email} (${user.displayName})` : user.email

const setSuperAdmin = async (
  prisma: PrismaClient,
  email: string,
  superAdmin: boolean,
): Promise<void> => {
  const user = await prisma.user.findUnique({
    select: {
      displayName: true,
      email: true,
      id: true,
    },
    where: {
      email,
    },
  })

  if (!user) {
    throw new Error(`No user found with email ${email}.`)
  }

  await prisma.user.update({
    data: {
      superAdmin,
    },
    where: {
      id: user.id,
    },
  })

  const action = superAdmin ? 'Granted' : 'Revoked'
  console.log(`${action} platform super-admin for ${formatUser(user)}.`)
}

const listSuperAdmins = async (prisma: PrismaClient): Promise<void> => {
  const users = await prisma.user.findMany({
    orderBy: {
      email: 'asc',
    },
    select: {
      displayName: true,
      email: true,
    },
    where: {
      superAdmin: true,
    },
  })

  if (users.length === 0) {
    console.log('No platform super-admins.')
    return
  }

  for (const user of users) {
    console.log(formatUser(user))
  }
}

export const runSuperAdminCommand = async (
  command: SuperAdminCommand,
  args: string[],
): Promise<void> => {
  const prisma = createPrismaClient()
  try {
    switch (command) {
      case 'grant-super-admin':
        await setSuperAdmin(
          prisma,
          requireEmail(args, 'nessie grant-super-admin <email>'),
          true,
        )
        return
      case 'revoke-super-admin':
        await setSuperAdmin(
          prisma,
          requireEmail(args, 'nessie revoke-super-admin <email>'),
          false,
        )
        return
      case 'list-super-admins':
        if (args.length > 0) {
          throw new Error('Usage: nessie list-super-admins')
        }
        await listSuperAdmins(prisma)
        return
    }
  } finally {
    await disconnectPrismaClient()
  }
}
