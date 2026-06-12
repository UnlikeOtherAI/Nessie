import { type Prisma, type PrismaClient } from '@prisma/client'
import { probeProvider } from './providers.js'

export const registerExecutionRunners = async (
  prisma: PrismaClient,
  input: {
    labelPrefix: string
    organizationId?: string | null
  },
): Promise<void> => {
  const now = new Date()
  for (const provider of ['docker', 'gcloud'] as const) {
    const probe = await probeProvider(provider)
    const label = `${input.labelPrefix}-${provider}`

    await prisma.executionRunner.upsert({
      where: {
        provider_label: {
          label,
          provider,
        },
      },
      create: {
        capabilities: {
          mode: probe.capabilities,
          source: 'worker',
        } as Prisma.InputJsonValue,
        heartbeatAt: now,
        label,
        metadata: probe.metadata as Prisma.InputJsonValue,
        organizationId: input.organizationId ?? null,
        provider,
        status: probe.available ? 'active' : 'offline',
      },
      update: {
        capabilities: {
          mode: probe.capabilities,
          source: 'worker',
        } as Prisma.InputJsonValue,
        heartbeatAt: now,
        metadata: probe.metadata as Prisma.InputJsonValue,
        organizationId: input.organizationId ?? null,
        status: probe.available ? 'active' : 'offline',
      },
    })
  }
}
