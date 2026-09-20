import type { PrismaClient } from '@prisma/client'
import { ObservedLocalModelSchema, type AgentModelOption } from '@nessie/schemas'
import { LOCAL_INFERENCE_ENABLED_SETTING_KEY, resolveScopedSetting } from '@nessie/runtime'

/**
 * The model picker only sees observations from the caller's own live host.
 * A local row is a request to begin the explicit consent flow, not a portable
 * provider endpoint and not a way to borrow a teammate's computer.
 */
export const listLocalInferenceModelOptions = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<AgentModelOption[]> => {
  const enabled = await resolveScopedSetting<boolean>(prisma, {
    organizationId: input.organizationId,
    userId: input.userId,
  }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
  if (enabled.value !== true) return []

  const freshAfter = new Date(Date.now() - 60_000)
  const hosts = await prisma.localInferenceHost.findMany({
    where: {
      custodianUserId: input.userId,
      organizationId: input.organizationId,
      pausedAt: null,
      revokedAt: null,
      inventoryObservedAt: { gt: freshAfter },
      lastSeenAt: { gt: freshAfter },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, inventory: true, transport: true },
  })

  return hosts.flatMap((host) => {
    const inventory = ObservedLocalModelSchema.array().safeParse(host.inventory)
    if (!inventory.success) return []
    return inventory.data.flatMap((model) => (
      model.remoteHost === null
      && model.remoteModel === null
      && model.capabilities.includes('text')
        ? [{
          description: `Runs on your ${host.transport === 'desktop' ? 'Nessie Desktop' : 'paired executor'} after you approve it.`,
          displayName: model.name,
          localInferenceHostId: host.id,
          localManifestDigest: model.manifestDigest,
          model: model.name,
          provider: 'local/ollama',
          providerDisplayName: 'Local Ollama',
          source: 'local' as const,
        }]
        : []
    ))
  })
}
