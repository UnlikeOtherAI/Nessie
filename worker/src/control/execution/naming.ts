export const sanitizeNamePart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

export const buildDockerContainerName = (instanceId: string): string =>
  `nessie-ee-${sanitizeNamePart(instanceId.replace(/-/g, '')).slice(0, 24)}`

export const buildGcloudInstanceName = (instanceId: string): string =>
  `nessie-ee-${sanitizeNamePart(instanceId.replace(/-/g, '')).slice(0, 40)}`

export const buildSystemLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  'nessie.instance-id': input.instanceId,
  'nessie.organization-id': input.organizationId,
})

export const buildGcloudLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  nessie_instance: sanitizeNamePart(input.instanceId).slice(0, 63),
  nessie_org: sanitizeNamePart(input.organizationId).slice(0, 63),
})
