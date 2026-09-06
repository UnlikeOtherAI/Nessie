import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from './command-runner.js'
import { mergeLaunchConfig } from './launch-config.js'
import { buildGcloudInstanceName, buildGcloudLabels, sanitizeNamePart } from './naming.js'
import { parseString, parseStringArray, parseStringRecord } from './stored-json.js'
import type {
  ProviderProbe,
  ProviderProvisionResult,
  ProvisioningContext,
  TerminationContext,
} from './types.js'

export const buildGcloudRunJobArgs = (input: {
  env: Record<string, string>
  image: string
  jobName: string
  maxRetries?: string
  projectId: string
  region: string
  tasks?: string
}): { deployArgs: string[]; executeArgs: string[] } => {
  const deployArgs = [
    'run',
    'jobs',
    'deploy',
    input.jobName,
    '--project',
    input.projectId,
    '--region',
    input.region,
    '--image',
    input.image,
    '--quiet',
    '--format=json',
  ]

  if (Object.keys(input.env).length > 0) {
    deployArgs.push(
      '--set-env-vars',
      Object.entries(input.env)
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
    )
  }

  if (input.tasks) {
    deployArgs.push('--tasks', input.tasks)
  }

  if (input.maxRetries) {
    deployArgs.push('--max-retries', input.maxRetries)
  }

  return {
    deployArgs,
    executeArgs: [
      'run',
      'jobs',
      'execute',
      input.jobName,
      '--project',
      input.projectId,
      '--region',
      input.region,
      '--wait',
      '--quiet',
      '--format=json',
    ],
  }
}

export const probeGcloud = async (): Promise<ProviderProbe> => {
  try {
    const { stdout } = await runCommand('gcloud', ['--version'])
    const versionLine = stdout
      .split('\n')
      .find((line) => line.toLowerCase().includes('google cloud sdk'))
    return {
      available: true,
      capabilities: ['vm', 'function'],
      metadata: {
        source: 'worker',
        version: versionLine ?? 'unknown',
      },
    }
  } catch (error) {
    return {
      available: false,
      capabilities: ['vm', 'function'],
      metadata: {
        source: 'worker',
        error: error instanceof Error ? error.message : 'gcloud unavailable',
      },
    }
  }
}

const gcloudLaunchConfig = (context: ProvisioningContext): Record<string, unknown> =>
  mergeLaunchConfig(context.instance.template.launchConfig, context.instance.launchConfig)

type GcloudVmTarget = {
  metadata: Record<string, unknown>
  name: string
  projectId: string
  providerInstanceRef: string
  zone: string
}

type GcloudFunctionTarget = {
  image: string
  jobName: string
  metadata: Record<string, unknown>
  projectId: string
  providerInstanceRef: string
  region: string
}

// The single place a `gcloud:vm:…` reference is spelled, and the single place
// the VM's name is decided. `buildGcloudVmArgs` and
// `deriveGcloudProviderInstanceRef` both go through it, so the reference
// written to the instance row *before* `gcloud compute instances create` runs
// and the one written after it returns cannot drift apart. Returns null when
// the launch config cannot name a target; the caller decides whether that is a
// provisioning error or simply nothing to derive.
const resolveGcloudVmTarget = (
  context: ProvisioningContext,
  config: Record<string, unknown>,
): GcloudVmTarget | null => {
  const projectId = parseString(config['projectId'])
  const zone = parseString(config['zone'])
  if (!projectId || !zone) {
    return null
  }

  const name = parseString(config['instanceName']) ?? buildGcloudInstanceName(context.instance.id)

  return {
    metadata: {
      instanceName: name,
      projectId,
      zone,
    },
    name,
    projectId,
    providerInstanceRef: `gcloud:vm:${projectId}:${zone}:${name}`,
    zone,
  }
}

// The same contract for Cloud Run jobs: one spelling of `gcloud:function:…`,
// one decision about `jobName`, shared by the deploy/execute arg builder and
// the pre-provision derivation.
const resolveGcloudFunctionTarget = (
  context: ProvisioningContext,
  config: Record<string, unknown>,
): GcloudFunctionTarget | null => {
  const projectId = parseString(config['projectId'])
  const region = parseString(config['region'])
  const image = parseString(config['image']) ?? context.instance.template.image ?? undefined
  if (!projectId || !region || !image) {
    return null
  }

  const jobName = parseString(config['jobName']) ?? buildGcloudInstanceName(context.instance.id)

  return {
    image,
    jobName,
    metadata: {
      jobName,
      projectId,
      region,
    },
    projectId,
    providerInstanceRef: `gcloud:function:${projectId}:${region}:${jobName}`,
    region,
  }
}

// The reference a gcloud provision *will* create, computed before the provider
// is called. Both names are deterministic — the launch config's explicit
// `instanceName`/`jobName`, otherwise `buildGcloudInstanceName(instance.id)` —
// so the full reference is knowable from the instance row alone, which is what
// lets `allocateExecutionEnvironmentInstance` record the intent before the side
// effect. Null means there is nothing to derive: an incomplete launch config
// (the provision below is about to throw over the same fields) or a mode this
// provider does not implement.
export const deriveGcloudProviderInstanceRef = (
  context: ProvisioningContext,
): string | null => {
  const config = gcloudLaunchConfig(context)

  if (context.instance.template.mode === 'vm') {
    return resolveGcloudVmTarget(context, config)?.providerInstanceRef ?? null
  }
  if (context.instance.template.mode === 'function') {
    return resolveGcloudFunctionTarget(context, config)?.providerInstanceRef ?? null
  }

  return null
}

const buildGcloudVmArgs = async (
  context: ProvisioningContext,
): Promise<{
  args: string[]
  cleanup: Array<() => Promise<void>>
  metadata: Record<string, unknown>
  providerInstanceRef: string
}> => {
  const config = gcloudLaunchConfig(context)
  const target = resolveGcloudVmTarget(context, config)
  if (!target) {
    throw new Error('GCLOUD_VM_PROJECT_AND_ZONE_REQUIRED')
  }
  const { name, projectId, zone } = target

  const args = [
    'compute',
    'instances',
    'create',
    name,
    '--project',
    projectId,
    '--zone',
    zone,
    '--quiet',
    '--format=json',
  ]

  const machineType = parseString(config['machineType']) ?? 'e2-standard-2'
  args.push('--machine-type', machineType)

  const sourceMachineImage = parseString(config['sourceMachineImage'])
  const image = parseString(config['image']) ?? context.instance.template.image ?? undefined
  const imageProject = parseString(config['imageProject'])
  const imageFamily = parseString(config['imageFamily'])

  if (sourceMachineImage) {
    args.push('--source-machine-image', sourceMachineImage)
  } else if (image) {
    args.push('--image', image)
    if (imageProject) {
      args.push('--image-project', imageProject)
    }
  } else if (imageFamily && imageProject) {
    args.push('--image-family', imageFamily, '--image-project', imageProject)
  } else {
    throw new Error('GCLOUD_VM_IMAGE_REQUIRED')
  }

  const serviceAccount = parseString(config['serviceAccount'])
  if (serviceAccount) {
    args.push('--service-account', serviceAccount)
  }

  const network = parseString(config['network'])
  if (network) {
    args.push('--network', network)
  }
  const subnet = parseString(config['subnet'])
  if (subnet) {
    args.push('--subnet', subnet)
  }

  const scopes = parseStringArray(config['scopes'])
  if (scopes.length > 0) {
    args.push('--scopes', scopes.join(','))
  }

  const tags = parseStringArray(config['tags'])
  if (tags.length > 0) {
    args.push('--tags', tags.join(','))
  }

  const labels = {
    ...buildGcloudLabels({
      instanceId: context.instance.id,
      organizationId: context.instance.organizationId,
    }),
    ...Object.fromEntries(
      Object.entries(parseStringRecord(config['labels'])).map(([key, value]) => [
        sanitizeNamePart(key).replace(/-/g, '_').slice(0, 63),
        sanitizeNamePart(value).slice(0, 63),
      ]),
    ),
  }
  if (Object.keys(labels).length > 0) {
    args.push(
      '--labels',
      Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
    )
  }

  const metadata = {
    ...parseStringRecord(config['metadata']),
    nessie_instance_id: context.instance.id,
  }
  if (Object.keys(metadata).length > 0) {
    args.push(
      '--metadata',
      Object.entries(metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
    )
  }

  const cleanup: Array<() => Promise<void>> = []
  const startupScript = parseString(config['startupScript'])
  if (startupScript) {
    const dir = await mkdtemp(path.join(tmpdir(), 'nessie-gcloud-'))
    const startupScriptPath = path.join(dir, 'startup.sh')
    await writeFile(startupScriptPath, startupScript, 'utf8')
    args.push('--metadata-from-file', `startup-script=${startupScriptPath}`)
    cleanup.push(async () => {
      await rm(dir, { force: true, recursive: true })
    })
  }

  return {
    args,
    cleanup,
    metadata: target.metadata,
    providerInstanceRef: target.providerInstanceRef,
  }
}

const buildGcloudFunctionArgs = (
  context: ProvisioningContext,
): {
  deployArgs: string[]
  executeArgs: string[]
  metadata: Record<string, unknown>
  providerInstanceRef: string
} => {
  const config = gcloudLaunchConfig(context)
  const target = resolveGcloudFunctionTarget(context, config)
  if (!target) {
    throw new Error('GCLOUD_FUNCTION_PROJECT_REGION_IMAGE_REQUIRED')
  }
  const { image, jobName, projectId, region } = target

  const env = parseStringRecord(config['env'])
  const tasks = parseString(config['tasks'])
  const maxRetries = parseString(config['maxRetries'])
  const { deployArgs, executeArgs } = buildGcloudRunJobArgs({
    env,
    image,
    jobName,
    projectId,
    region,
    ...(tasks ? { tasks } : {}),
    ...(maxRetries ? { maxRetries } : {}),
  })

  return {
    deployArgs,
    executeArgs,
    metadata: target.metadata,
    providerInstanceRef: target.providerInstanceRef,
  }
}

export const provisionGcloud = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> => {
  if (context.instance.template.mode === 'vm') {
    const { args, cleanup, metadata, providerInstanceRef } = await buildGcloudVmArgs(context)
    try {
      await runCommand('gcloud', args)
    } finally {
      await Promise.all(cleanup.map((fn) => fn()))
    }

    return {
      providerInstanceRef,
      status: 'ready',
      metadata,
    }
  }

  if (context.instance.template.mode !== 'function') {
    throw new Error(`GCLOUD_MODE_UNSUPPORTED:${context.instance.template.mode}`)
  }

  const { deployArgs, executeArgs, metadata, providerInstanceRef } = buildGcloudFunctionArgs(context)

  await runCommand('gcloud', deployArgs)
  await runCommand('gcloud', executeArgs)

  return {
    providerInstanceRef,
    status: 'terminated',
    metadata,
  }
}

export const terminateGcloud = async (
  context: TerminationContext,
): Promise<Record<string, unknown>> => {
  const ref = context.instance.providerInstanceRef
  if (!ref) {
    return {}
  }

  const parts = ref.split(':')
  if (parts.length < 5 || parts[0] !== 'gcloud') {
    return {}
  }

  if (parts[1] === 'vm') {
    const [, , projectId, zone, name] = parts
    try {
      await runCommand('gcloud', [
        'compute',
        'instances',
        'delete',
        name!,
        '--project',
        projectId!,
        '--zone',
        zone!,
        '--quiet',
      ])
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('not found')) {
        throw error
      }
    }

    return {
      instanceName: name,
      projectId,
      terminatedBy: 'gcloud',
      zone,
    }
  }

  const [, , projectId, region, jobName] = parts
  try {
    await runCommand('gcloud', [
      'run',
      'jobs',
      'delete',
      jobName!,
      '--project',
      projectId!,
      '--region',
      region!,
      '--quiet',
    ])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.toLowerCase().includes('not found')) {
      throw error
    }
  }

  return {
    jobName,
    projectId,
    region,
    terminatedBy: 'gcloud',
  }
}
