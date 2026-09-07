import { runCommand } from './command-runner.js'
import type { CommandRunner } from './command-runner.js'
import { mergeLaunchConfig } from './launch-config.js'
import { INSTANCE_ID_LABEL, buildDockerContainerName, buildSystemLabels } from './naming.js'
import { parseString, parseStringArray, parseStringRecord } from './stored-json.js'
import type {
  ProviderProbe,
  ProviderProvisionResult,
  ProviderTerminationResult,
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

  // System labels last, so a template's `labels` cannot overwrite them.
  // `nessie.instance-id` is what `adoptOwnContainer` below trusts to decide
  // whether a container under a wanted name belongs to this instance row; a
  // template that could set it could make one row adopt another's container.
  const labels = {
    ...parseStringRecord(config['labels']),
    ...buildSystemLabels({
      instanceId: context.instance.id,
      organizationId: context.instance.organizationId,
    }),
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

// A row may only ever name a machine no other row can name — the rule
// `deriveGcloudProviderInstanceRef` already follows for a pinned
// `instanceName`/`jobName` (`docs/standards/horizontal-scaling/storage-and-realtime.md`, invariant 7).
// `containerName` is pinnable on a template too, so every instance launched from
// such a template runs `docker run --name <the same name>` and every one after
// the first is told the name is already in use.
//
// Adopting whatever holds the name is how that used to be answered, and it is
// worse than the collision it hides: two instance rows end up carrying one
// container id, so terminating either — a person clicking terminate, a lease
// sweep, `cleanupProvisionedInstance` after a lost race — destroys the other's
// live environment, and the surviving row still says `ready`. The collision must
// fail instead, loudly, on the instance that lost.
//
// The one container this instance may adopt is its own: `docker run` succeeded
// and the worker died before the row was written, so the retry meets a container
// it created itself. The `nessie.instance-id` label is the proof, and
// `buildDockerProvisionArgs` stamps it after a template's own labels so nothing
// but a real Nessie provision can claim it.
const adoptOwnContainer = async (input: {
  containerName: string
  instanceId: string
}, commandRunner: CommandRunner): Promise<string> => {
  const { stdout } = await commandRunner('docker', [
    'inspect',
    input.containerName,
    '--format',
    `{{.Id}}\t{{index .Config.Labels "${INSTANCE_ID_LABEL}"}}`,
  ])
  const [containerId, label] = stdout.trim().split('\t')
  // Docker prints `<no value>` for a label the container does not carry, which
  // is what a container Nessie never launched looks like from here.
  const ownerInstanceId = !label || label === '<no value>' ? null : label

  if (ownerInstanceId !== input.instanceId) {
    throw new Error(
      `DOCKER_CONTAINER_NAME_IN_USE:${input.containerName}`
      + `:owned-by:${ownerInstanceId ?? 'a container Nessie did not launch'}`,
    )
  }

  return containerId ?? ''
}

export const provisionDocker = async (
  context: ProvisioningContext,
  commandRunner: CommandRunner = runCommand,
): Promise<ProviderProvisionResult> => {
  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const containerName = parseString(config['containerName'])
    ?? buildDockerContainerName(context.instance.id)

  let containerId = ''
  try {
    const { stdout } = await commandRunner('docker', buildDockerProvisionArgs(context))
    containerId = stdout.trim()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already in use')) {
      throw error
    }
    containerId = await adoptOwnContainer({
      containerName,
      instanceId: context.instance.id,
    }, commandRunner)
  }

  if (!containerId) {
    throw new Error('DOCKER_CONTAINER_ID_MISSING')
  }

  const { stdout } = await commandRunner('docker', ['inspect', containerId, '--format', '{{json .State}}'])
  const state = JSON.parse(stdout) as { Running?: boolean; Status?: string }
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

// `soleDaemon` is the whole difference between "already gone" and "not here".
// In `local` mode there is one process and one Docker daemon, so a
// `No such container` comes from the only daemon that could ever have held the
// container and proves it is gone. Anywhere else the daemon this replica reached
// is not necessarily the container's host — queue jobs are not host-routed — so
// the same answer proves nothing, and the terminate says `unverified` rather
// than letting the row claim a container is gone while it runs on and bills.
export const terminateDocker = async (
  context: TerminationContext,
  input: { soleDaemon: boolean },
  commandRunner: CommandRunner = runCommand,
): Promise<ProviderTerminationResult> => {
  if (!context.instance.providerInstanceRef) {
    // This row never named a container, so nothing it records can be a claim
    // about one. Docker derives no reference before provisioning, so a row
    // without one is an instance whose provision never got a container id back.
    return { metadata: {}, outcome: 'terminated' }
  }

  try {
    await commandRunner('docker', ['rm', '-f', context.instance.providerInstanceRef])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('No such container')) {
      throw error
    }

    if (!input.soleDaemon) {
      return {
        metadata: {
          containerId: context.instance.providerInstanceRef,
          terminateUnverifiedBy: 'docker',
          terminateUnverifiedReason: 'DOCKER_NO_SUCH_CONTAINER',
        },
        outcome: 'unverified',
      }
    }
  }

  return {
    metadata: {
      containerId: context.instance.providerInstanceRef,
      terminatedBy: 'docker',
    },
    outcome: 'terminated',
  }
}
