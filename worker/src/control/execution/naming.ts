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

// The label that says which instance row owns a container. It is how an operator
// finds an abandoned container on the runner's own host, and — since a launch
// config may pin a `containerName` that several instances share — the only
// evidence that a container found under a name this provision wanted is one this
// same instance created. `provisionDocker` reads it before it will adopt
// anything, so it must be stamped by Nessie and never by a template.
export const INSTANCE_ID_LABEL = 'nessie.instance-id'

export const buildSystemLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  [INSTANCE_ID_LABEL]: input.instanceId,
  'nessie.organization-id': input.organizationId,
})

export const buildGcloudLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  nessie_instance: sanitizeNamePart(input.instanceId).slice(0, 63),
  nessie_org: sanitizeNamePart(input.organizationId).slice(0, 63),
})
