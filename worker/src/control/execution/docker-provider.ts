import { runCommand, runJsonCommand } from './command-runner.js'
import { mergeLaunchConfig } from './launch-config.js'
import { buildDockerContainerName, buildSystemLabels } from './naming.js'
import { parseString, parseStringArray, parseStringRecord } from './stored-json.js'
import type {
  ProviderProbe,
  ProviderProvisionResult,
  ProvisioningContext,
  TerminationContext,
} from './types.js'

const buildDockerCommandArgs = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return ['sh', '-lc', value]
  }
  return parseStringArray(value)
}

const buildDockerProvisionArgs = (context: ProvisioningContext): string[] => {
  if (context.instance.template.mode !== 'container') {
    throw new Error(`DOCKER_MODE_UNSUPPORTED:${context.instance.template.mode}`)
  }

  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const image = parseString(config['image']) ?? context.instance.template.image ?? undefined
  if (!image) {
    throw new Error('DOCKER_IMAGE_REQUIRED')
  }

  const name = parseString(config['containerName']) ?? buildDockerContainerName(context.instance.id)
  const args = ['run', '-d', '--name', name]

  const labels = {
    ...buildSystemLabels({
      instanceId: context.instance.id,
      organizationId: context.instance.organizationId,
    }),
    ...parseStringRecord(config['labels']),
  }
  for (const [key, value] of Object.entries(labels)) {
    args.push('--label', `${key}=${value}`)
  }

  const env = parseStringRecord(config['env'])
  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`)
  }

  const workdir = parseString(config['workingDir'])
  if (workdir) {
    args.push('--workdir', workdir)
  }

  const network = parseString(config['network'])
  if (network) {
    args.push('--network', network)
  }

  for (const portMapping of parseStringArray(config['ports'])) {
    args.push('--publish', portMapping)
  }

  for (const mount of parseStringArray(config['mounts'])) {
    args.push('--volume', mount)
  }

  const entrypoint = parseString(config['entrypoint'])
  if (entrypoint) {
    args.push('--entrypoint', entrypoint)
  }

  args.push(image)
  args.push(...buildDockerCommandArgs(config['command']))

  return args
}

export const probeDocker = async (): Promise<ProviderProbe> => {
  try {
    const { stdout } = await runCommand('docker', ['version', '--format', '{{json .Server}}'])
    const server = JSON.parse(stdout) as { Version?: string }
    return {
      available: true,
      capabilities: ['container'],
      metadata: {
        source: 'worker',
        version: server.Version ?? 'unknown',
      },
    }
  } catch (error) {
    return {
      available: false,
      capabilities: ['container'],
      metadata: {
        source: 'worker',
        error: error instanceof Error ? error.message : 'Docker unavailable',
      },
    }
  }
}

export const provisionDocker = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> => {
  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const containerName = parseString(config['containerName'])
    ?? buildDockerContainerName(context.instance.id)

  let containerId = ''
  try {
    const { stdout } = await runCommand('docker', buildDockerProvisionArgs(context))
    containerId = stdout.trim()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already in use')) {
      throw error
    }
    const { stdout } = await runCommand('docker', [
      'inspect',
      containerName,
      '--format',
      '{{.Id}}',
    ])
    containerId = stdout.trim()
  }

  if (!containerId) {
    throw new Error('DOCKER_CONTAINER_ID_MISSING')
  }

  const state = await runJsonCommand<{ Running?: boolean; Status?: string }>('docker', [
    'inspect',
    containerId,
    '--format',
    '{{json .State}}',
  ])
  if (!state.Running) {
    throw new Error(`DOCKER_CONTAINER_NOT_RUNNING:${state.Status ?? 'unknown'}`)
  }

  return {
    providerInstanceRef: containerId,
    status: 'ready',
    metadata: {
      containerId,
      containerName,
      image: parseString(config['image']) ?? context.instance.template.image ?? undefined,
      state: state.Status ?? 'running',
    },
  }
}

export const terminateDocker = async (
  context: TerminationContext,
): Promise<Record<string, unknown>> => {
  if (!context.instance.providerInstanceRef) {
    return {}
  }

  try {
    await runCommand('docker', ['rm', '-f', context.instance.providerInstanceRef])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container')) {
      throw error
    }
  }

  return {
    containerId: context.instance.providerInstanceRef,
    terminatedBy: 'docker',
  }
}
