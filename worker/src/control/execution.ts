import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '../queue.js'
import { markWorkflowStepRunFinished } from '../run/workflows.js'

const execFile = promisify(execFileCallback)

const DEFAULT_LEASE_TTL_MS = 5 * 60_000
const DEFAULT_RUNNER_STALE_MS = 90_000

type ExecutionProvider = 'docker' | 'gcloud'
type ExecutionMode = 'container' | 'function' | 'vm'

type ProviderProbe = {
  available: boolean
  capabilities: string[]
  metadata: Record<string, unknown>
}

type ProviderProvisionResult = {
  metadata?: Record<string, unknown>
  providerInstanceRef: string
  status: 'ready' | 'terminated'
}

type ProvisioningContext = {
  instance: {
    agentId: string | null
    channelId: string | null
    id: string
    launchConfig: unknown
    launchedByActorId: string
    launchedByActorType: string
    metadata: unknown
    organizationId: string
    projectId: string | null
    providerInstanceRef: string | null
    runId: string | null
    startedAt: Date | null
    status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
    teamId: string | null
    workflowRunId: string | null
    workflowStepRunId: string | null
    template: {
      id: string
      image: string | null
      launchConfig: unknown
      mode: ExecutionMode
      pricingConfig: unknown
      provider: ExecutionProvider
    }
  }
  leaseId: string
  runnerId: string
}

type TerminationContext = {
  instance: {
    agentId: string | null
    channelId: string | null
    id: string
    launchConfig: unknown
    launchedByActorId: string
    launchedByActorType: string
    metadata: unknown
    organizationId: string
    projectId: string | null
    providerInstanceRef: string | null
    readyAt: Date | null
    runId: string | null
    startedAt: Date | null
    status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
    teamId: string | null
    terminatedAt: Date | null
    workflowRunId: string | null
    workflowStepRunId: string | null
    template: {
      id: string
      image: string | null
      launchConfig: unknown
      mode: ExecutionMode
      pricingConfig: unknown
      provider: ExecutionProvider
    }
  }
}

type WorkflowLinkedInstance = Pick<
  ProvisioningContext['instance'],
  | 'agentId'
  | 'channelId'
  | 'id'
  | 'launchedByActorId'
  | 'launchedByActorType'
  | 'organizationId'
  | 'projectId'
  | 'runId'
  | 'teamId'
  | 'workflowRunId'
  | 'workflowStepRunId'
>

type WorkflowInstanceState = WorkflowLinkedInstance & {
  errorMessage: string | null
  metadata: unknown
  providerInstanceRef: string | null
  status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const parseNonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const parseString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const parseStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []

const parseStringRecord = (value: unknown): Record<string, string> => {
  const record = asObject(value)
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  )
}

const computeUsageCost = (input: {
  pricingConfig: unknown
  quantity: number
}): { costAmount?: number; currency?: string; unitPrice?: number } => {
  const pricing = asObject(input.pricingConfig)
  const unitPrice = parseNonNegativeNumber(pricing['unitPrice'])
  const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : undefined

  if (unitPrice === null) {
    return { currency }
  }

  return {
    unitPrice,
    costAmount: Number((unitPrice * input.quantity).toFixed(6)),
    currency,
  }
}

const mergeMetadata = (
  existing: unknown,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue => ({
  ...asObject(existing),
  ...patch,
}) as Prisma.InputJsonValue

const mergeLaunchConfig = (
  templateConfig: unknown,
  instanceConfig: unknown,
): Record<string, unknown> => {
  const templateRecord = asObject(templateConfig)
  const instanceRecord = asObject(instanceConfig)

  return {
    ...templateRecord,
    ...instanceRecord,
    env: {
      ...parseStringRecord(templateRecord['env']),
      ...parseStringRecord(instanceRecord['env']),
    },
    labels: {
      ...parseStringRecord(templateRecord['labels']),
      ...parseStringRecord(instanceRecord['labels']),
    },
    metadata: {
      ...parseStringRecord(templateRecord['metadata']),
      ...parseStringRecord(instanceRecord['metadata']),
    },
  }
}

const sanitizeNamePart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

const buildDockerContainerName = (instanceId: string): string =>
  `nessie-ee-${sanitizeNamePart(instanceId.replace(/-/g, '')).slice(0, 24)}`

const buildGcloudInstanceName = (instanceId: string): string =>
  `nessie-ee-${sanitizeNamePart(instanceId.replace(/-/g, '')).slice(0, 40)}`

const buildSystemLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  'nessie.instance-id': input.instanceId,
  'nessie.organization-id': input.organizationId,
})

const buildGcloudLabels = (input: {
  instanceId: string
  organizationId: string
}): Record<string, string> => ({
  nessie_instance: sanitizeNamePart(input.instanceId).slice(0, 63),
  nessie_org: sanitizeNamePart(input.organizationId).slice(0, 63),
})

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

const formatCommandError = (error: unknown, command: string, args: string[]): Error => {
  if (!(error instanceof Error)) {
    return new Error(`${command} ${args.join(' ')} failed`)
  }

  const withStreams = error as Error & {
    stderr?: string
    stdout?: string
  }
  const stderr = typeof withStreams.stderr === 'string' ? withStreams.stderr.trim() : ''
  const stdout = typeof withStreams.stdout === 'string' ? withStreams.stdout.trim() : ''
  const detail = stderr || stdout || error.message

  return new Error(`${command} ${args.join(' ')} failed: ${detail}`)
}

const runCommand = async (
  command: string,
  args: string[],
): Promise<{ stderr: string; stdout: string }> => {
  try {
    const result = await execFile(command, args, {
      maxBuffer: 10 * 1024 * 1024,
    })
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } catch (error) {
    throw formatCommandError(error, command, args)
  }
}

const runJsonCommand = async <T>(
  command: string,
  args: string[],
): Promise<T> => {
  const { stdout } = await runCommand(command, args)
  return JSON.parse(stdout) as T
}

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

const probeDocker = async (): Promise<ProviderProbe> => {
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

const provisionDocker = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> => {
  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const containerName = parseString(config['containerName']) ?? buildDockerContainerName(context.instance.id)

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

const terminateDocker = async (context: TerminationContext): Promise<Record<string, unknown>> => {
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

const probeGcloud = async (): Promise<ProviderProbe> => {
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

const buildGcloudVmArgs = async (
  context: ProvisioningContext,
): Promise<{
  args: string[]
  cleanup: Array<() => Promise<void>>
  metadata: Record<string, unknown>
  providerInstanceRef: string
}> => {
  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const projectId = parseString(config['projectId'])
  const zone = parseString(config['zone'])
  if (!projectId || !zone) {
    throw new Error('GCLOUD_VM_PROJECT_AND_ZONE_REQUIRED')
  }

  const name = parseString(config['instanceName']) ?? buildGcloudInstanceName(context.instance.id)
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
    metadata: {
      instanceName: name,
      projectId,
      zone,
    },
    providerInstanceRef: `gcloud:vm:${projectId}:${zone}:${name}`,
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
  const config = mergeLaunchConfig(
    context.instance.template.launchConfig,
    context.instance.launchConfig,
  )
  const projectId = parseString(config['projectId'])
  const region = parseString(config['region'])
  const image = parseString(config['image']) ?? context.instance.template.image ?? undefined
  if (!projectId || !region || !image) {
    throw new Error('GCLOUD_FUNCTION_PROJECT_REGION_IMAGE_REQUIRED')
  }

  const jobName = parseString(config['jobName']) ?? buildGcloudInstanceName(context.instance.id)
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
    metadata: {
      jobName,
      projectId,
      region,
    },
    providerInstanceRef: `gcloud:function:${projectId}:${region}:${jobName}`,
  }
}

const provisionGcloud = async (
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

const terminateGcloud = async (context: TerminationContext): Promise<Record<string, unknown>> => {
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

const probeProvider = async (provider: ExecutionProvider): Promise<ProviderProbe> =>
  provider === 'docker' ? probeDocker() : probeGcloud()

const provisionProviderInstance = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> =>
  context.instance.template.provider === 'docker'
    ? provisionDocker(context)
    : provisionGcloud(context)

const terminateProviderInstance = async (
  context: TerminationContext,
): Promise<Record<string, unknown>> =>
  context.instance.template.provider === 'docker'
    ? terminateDocker(context)
    : terminateGcloud(context)

const recordExecutionUsage = async (
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    actorType: string
    agentId: string | null
    channelId: string | null
    instanceId: string
    metadata?: Record<string, unknown>
    meterType: string
    organizationId: string
    projectId: string | null
    quantity: number
    runId: string | null
    teamId: string | null
    templateId: string
    templatePricingConfig: unknown
    workflowRunId: string | null
    workflowStepRunId: string | null
  },
): Promise<void> => {
  const pricing = computeUsageCost({
    pricingConfig: input.templatePricingConfig,
    quantity: input.quantity,
  })

  await tx.executionUsageLedger.create({
    data: {
      actorId: input.actorId,
      actorType: input.actorType,
      agentId: input.agentId,
      channelId: input.channelId,
      costAmount: pricing.costAmount,
      currency: pricing.currency,
      instanceId: input.instanceId,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      meterType: input.meterType,
      organizationId: input.organizationId,
      projectId: input.projectId,
      quantity: input.quantity,
      runId: input.runId,
      teamId: input.teamId,
      templateId: input.templateId,
      unitPrice: pricing.unitPrice,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
    },
  })
}

const buildWorkflowActorContext = (instance: WorkflowLinkedInstance) => ({
  actor: {
    actorId: instance.launchedByActorId,
    actorType: instance.launchedByActorType as 'agent' | 'service' | 'user',
  },
  tenant: {
    organizationId: instance.organizationId,
    ...(instance.projectId ? { projectId: instance.projectId } : {}),
    ...(instance.teamId ? { teamId: instance.teamId } : {}),
    ...(instance.channelId ? { channelId: instance.channelId } : {}),
  },
  actionContext: {
    requestId: `execution-environment:${instance.id}`,
    correlationId: instance.workflowStepRunId ?? instance.workflowRunId ?? instance.id,
    ...(instance.channelId ? { channelId: instance.channelId } : {}),
    purpose: 'workflow.environment.allocate',
    sessionId: instance.workflowRunId ?? instance.id,
  },
})

const maybeContinueWorkflowForInstance = async (
  prisma: PrismaClient,
  input: {
    instance: WorkflowLinkedInstance
    output?: Record<string, unknown>
    success: boolean
    summary?: string
  },
): Promise<void> => {
  if (!input.instance.workflowRunId || !input.instance.workflowStepRunId) {
    return
  }

  const result = await markWorkflowStepRunFinished(prisma, {
    output: input.output,
    stepRunId: input.instance.workflowStepRunId,
    success: input.success,
    summary: input.summary,
    workflowRunId: input.instance.workflowRunId,
  })
  if (!result.continueWorkflow) {
    return
  }

  await enqueueQueueJob(prisma, {
    idempotencyKey: `workflow-run:continue:${input.instance.workflowRunId}:${input.instance.workflowStepRunId}`,
    payload: {
      actorContext: buildWorkflowActorContext(input.instance),
      workflowRunId: input.instance.workflowRunId,
    },
    topic: 'workflow.run.execute',
  })
}

const buildWorkflowInstanceOutput = (input: {
  errorMessage?: string | null
  instanceId: string
  metadata?: unknown
  providerInstanceRef?: string | null
  status: string
}): Record<string, unknown> => ({
  environmentInstanceId: input.instanceId,
  status: input.status,
  ...(input.providerInstanceRef ? { providerInstanceRef: input.providerInstanceRef } : {}),
  ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  ...asObject(input.metadata),
})

const loadWorkflowInstanceState = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<WorkflowInstanceState | null> =>
  prisma.executionEnvironmentInstance.findUnique({
    where: { id: instanceId },
    select: {
      agentId: true,
      channelId: true,
      errorMessage: true,
      id: true,
      launchedByActorId: true,
      launchedByActorType: true,
      metadata: true,
      organizationId: true,
      projectId: true,
      providerInstanceRef: true,
      runId: true,
      status: true,
      teamId: true,
      workflowRunId: true,
      workflowStepRunId: true,
    },
  })

const cleanupProvisionedInstance = async (
  context: ProvisioningContext,
  provisioned: ProviderProvisionResult,
): Promise<void> => {
  try {
    await terminateProviderInstance({
      instance: {
        ...context.instance,
        readyAt: provisioned.status === 'ready' ? new Date() : null,
        providerInstanceRef: provisioned.providerInstanceRef,
        terminatedAt: provisioned.status === 'terminated' ? new Date() : null,
      },
    })
  } catch (error) {
    console.error('[worker.execution] stale provision cleanup failed', error)
  }
}

const selectRunner = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    provider: ExecutionProvider
    runnerLabelPrefix: string
  },
) =>
  tx.executionRunner.findFirst({
    where: {
      provider: input.provider,
      status: 'active',
      label: `${input.runnerLabelPrefix}-${input.provider}`,
      heartbeatAt: {
        gt: new Date(Date.now() - DEFAULT_RUNNER_STALE_MS),
      },
      OR: [{ organizationId: input.organizationId }, { organizationId: null }],
    },
    orderBy: [{ organizationId: 'desc' }, { updatedAt: 'desc' }],
  })

const acknowledgeLease = async (
  prisma: PrismaClient,
  leaseId: string,
): Promise<boolean> => {
  const now = new Date()
  const updated = await prisma.executionLease.updateMany({
    where: {
      id: leaseId,
      status: 'issued',
      expiresAt: {
        gt: now,
      },
    },
    data: {
      status: 'acknowledged',
      acknowledgedAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
    },
  })

  return updated.count === 1
}

export const renewExecutionLeases = async (
  prisma: PrismaClient,
  input: {
    runnerLabelPrefix: string
  },
): Promise<number> => {
  const now = new Date()
  const runnerIds = await prisma.executionRunner.findMany({
    where: {
      label: {
        in: ['docker', 'gcloud'].map((provider) => `${input.runnerLabelPrefix}-${provider}`),
      },
      status: 'active',
      heartbeatAt: {
        gt: new Date(now.getTime() - DEFAULT_RUNNER_STALE_MS),
      },
    },
    select: { id: true },
  })
  if (runnerIds.length === 0) {
    return 0
  }

  const updated = await prisma.executionLease.updateMany({
    where: {
      runnerId: {
        in: runnerIds.map((runner) => runner.id),
      },
      status: 'acknowledged',
    },
    data: {
      expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
    },
  })

  return updated.count
}

const finalizeLease = async (
  tx: Prisma.TransactionClient,
  input: {
    leaseId: string
    status: 'completed' | 'expired' | 'revoked'
  },
): Promise<void> => {
  await tx.executionLease.updateMany({
    where: {
      id: input.leaseId,
      status: {
        in: ['issued', 'acknowledged'],
      },
    },
    data: {
      status: input.status,
      completedAt: new Date(),
    },
  })
}

const loadProvisioningContext = async (
  prisma: PrismaClient,
  instanceId: string,
  runnerLabelPrefix: string,
): Promise<ProvisioningContext | null> => {
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    const instance = await tx.executionEnvironmentInstance.findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            image: true,
            launchConfig: true,
            mode: true,
            pricingConfig: true,
            provider: true,
          },
        },
      },
    })
    if (!instance) {
      return null
    }
    if (!['pending', 'provisioning'].includes(instance.status)) {
      return null
    }

    const runner = await selectRunner(tx, {
      organizationId: instance.organizationId,
      provider: instance.template.provider,
      runnerLabelPrefix,
    })
    if (!runner) {
      const remoteRunner = await tx.executionRunner.findFirst({
        where: {
          provider: instance.template.provider,
          status: 'active',
          heartbeatAt: {
            gt: new Date(Date.now() - DEFAULT_RUNNER_STALE_MS),
          },
          OR: [{ organizationId: instance.organizationId }, { organizationId: null }],
        },
        select: { id: true },
      })

      if (remoteRunner) {
        throw new Error('EXECUTION_RUNNER_NOT_LOCAL')
      }

      await tx.executionEnvironmentInstance.update({
        where: { id: instance.id },
        data: {
          status: 'failed',
          errorMessage: `NO_${instance.template.provider.toUpperCase()}_RUNNER`,
          startedAt: instance.startedAt ?? now,
          lastHeartbeatAt: now,
        },
      })
      return null
    }

    await tx.executionEnvironmentInstance.update({
      where: { id: instance.id },
      data: {
        status: 'provisioning',
        startedAt: instance.startedAt ?? now,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(instance.metadata, {
          runnerId: runner.id,
          runnerLabel: runner.label,
        }),
      },
    })

    const lease = await tx.executionLease.create({
      data: {
        expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
        instanceId: instance.id,
        leaseToken: randomUUID(),
        runnerId: runner.id,
        status: 'issued',
      },
    })

    return {
      instance,
      leaseId: lease.id,
      runnerId: runner.id,
    }
  })
}

const loadTerminationContext = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<TerminationContext | null> =>
  prisma.executionEnvironmentInstance
    .findUnique({
      where: { id: instanceId },
      include: {
        template: {
          select: {
            id: true,
            image: true,
            launchConfig: true,
            mode: true,
            pricingConfig: true,
            provider: true,
          },
        },
      },
    })
    .then((instance) => (instance ? { instance } : null))

const markProvisionFailure = async (
  prisma: PrismaClient,
  context: ProvisioningContext,
  error: unknown,
): Promise<boolean> => {
  const now = new Date()
  const message = error instanceof Error ? error.message : 'Execution environment provisioning failed'

  const updated = await prisma.$transaction(async (tx) => {
    await finalizeLease(tx, {
      leaseId: context.leaseId,
      status: 'completed',
    })

    const failedUpdate = await tx.executionEnvironmentInstance.updateMany({
      where: {
        id: context.instance.id,
        status: {
          in: ['pending', 'provisioning'],
        },
      },
      data: {
        errorMessage: message,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(context.instance.metadata, {
          leaseFailedAt: now.toISOString(),
          leaseId: context.leaseId,
          runnerId: context.runnerId,
        }),
        status: 'failed',
      },
    })

    return failedUpdate.count === 1
  })

  if (updated) {
    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        errorMessage: message,
        instanceId: context.instance.id,
        metadata: context.instance.metadata,
        status: 'failed',
      }),
      success: false,
      summary: message,
    })
  }

  return updated
}

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

export const allocateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  input: {
    instanceId: string
    runnerLabelPrefix?: string
  },
): Promise<boolean> => {
  const context = await loadProvisioningContext(
    prisma,
    input.instanceId,
    input.runnerLabelPrefix ?? `${process.env.HOSTNAME ?? 'local-worker'}`,
  )
  if (!context) {
    const terminalInstance = await loadWorkflowInstanceState(prisma, input.instanceId)
    if (terminalInstance?.status === 'failed') {
      await maybeContinueWorkflowForInstance(prisma, {
        instance: terminalInstance,
        output: buildWorkflowInstanceOutput({
          errorMessage: terminalInstance.errorMessage,
          instanceId: terminalInstance.id,
          metadata: terminalInstance.metadata,
          providerInstanceRef: terminalInstance.providerInstanceRef,
          status: terminalInstance.status,
        }),
        success: false,
        summary: terminalInstance.errorMessage ?? 'Execution environment allocation failed.',
      })
    }
    return false
  }

  const acknowledged = await acknowledgeLease(prisma, context.leaseId)
  if (!acknowledged) {
    await markProvisionFailure(prisma, context, new Error('EXECUTION_LEASE_NOT_ACKNOWLEDGED'))
    return false
  }

  try {
    const provisioned = await provisionProviderInstance(context)
    const now = new Date()

    const persisted = await prisma.$transaction(async (tx) => {
      const finalizedLease = await tx.executionLease.updateMany({
        where: {
          id: context.leaseId,
          status: 'acknowledged',
        },
        data: {
          completedAt: now,
          status: 'completed',
        },
      })

      const updatedInstance = await tx.executionEnvironmentInstance.updateMany({
        where: {
          id: context.instance.id,
          status: {
            in: ['pending', 'provisioning'],
          },
        },
        data: {
          errorMessage: null,
          lastHeartbeatAt: now,
          metadata: mergeMetadata(context.instance.metadata, {
            leaseId: context.leaseId,
            runnerId: context.runnerId,
            ...(provisioned.metadata ?? {}),
          }),
          providerInstanceRef: provisioned.providerInstanceRef,
          readyAt: provisioned.status === 'ready' ? now : null,
          status: provisioned.status,
          terminatedAt: provisioned.status === 'terminated' ? now : null,
        },
      })

      if (finalizedLease.count !== 1 || updatedInstance.count !== 1) {
        return false
      }

      await recordExecutionUsage(tx, {
        actorId: context.instance.launchedByActorId,
        actorType: context.instance.launchedByActorType,
        agentId: context.instance.agentId,
        channelId: context.instance.channelId,
        instanceId: context.instance.id,
        metadata: {
          provider: context.instance.template.provider,
          runnerId: context.runnerId,
          ...(provisioned.metadata ?? {}),
        },
        meterType: 'allocation',
        organizationId: context.instance.organizationId,
        projectId: context.instance.projectId,
        quantity: 1,
        runId: context.instance.runId,
        teamId: context.instance.teamId,
        templateId: context.instance.template.id,
        templatePricingConfig: context.instance.template.pricingConfig,
        workflowRunId: context.instance.workflowRunId,
        workflowStepRunId: context.instance.workflowStepRunId,
      })

      return true
    })

    if (!persisted) {
      await cleanupProvisionedInstance(context, provisioned)
      const terminalInstance = await loadWorkflowInstanceState(prisma, context.instance.id)
      if (terminalInstance && ['failed', 'terminated'].includes(terminalInstance.status)) {
        await maybeContinueWorkflowForInstance(prisma, {
          instance: terminalInstance,
          output: buildWorkflowInstanceOutput({
            errorMessage: terminalInstance.errorMessage,
            instanceId: terminalInstance.id,
            metadata: terminalInstance.metadata,
            providerInstanceRef: terminalInstance.providerInstanceRef,
            status: terminalInstance.status,
          }),
          success: false,
          summary:
            terminalInstance.errorMessage
            ?? (terminalInstance.status === 'terminated'
              ? 'Execution environment terminated before activation completed.'
              : 'Execution environment activation did not complete.'),
        })
      }
      return false
    }

    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        instanceId: context.instance.id,
        metadata: {
          runnerId: context.runnerId,
          ...(provisioned.metadata ?? {}),
        },
        providerInstanceRef: provisioned.providerInstanceRef,
        status: provisioned.status,
      }),
      success: true,
      summary:
        provisioned.status === 'terminated'
          ? 'Execution environment completed and terminated.'
          : 'Execution environment is ready.',
    })

    return true
  } catch (error) {
    await markProvisionFailure(prisma, context, error)
    return false
  }
}

export const terminateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<boolean> => {
  const context = await loadTerminationContext(prisma, instanceId)
  if (!context) {
    return false
  }
  if (context.instance.status === 'terminated') {
    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        instanceId: context.instance.id,
        metadata: context.instance.metadata,
        providerInstanceRef: context.instance.providerInstanceRef,
        status: context.instance.status,
      }),
      success: false,
      summary: 'Execution environment was terminated.',
    })
    return true
  }

  const terminationMetadata = await terminateProviderInstance(context)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await tx.executionLease.updateMany({
      where: {
        instanceId: context.instance.id,
        status: {
          in: ['issued', 'acknowledged'],
        },
      },
      data: {
        completedAt: now,
        status: 'revoked',
      },
    })

    await tx.executionEnvironmentInstance.update({
      where: { id: context.instance.id },
      data: {
        errorMessage: null,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(context.instance.metadata, {
          terminationRequestedAt: null,
          ...(terminationMetadata ?? {}),
        }),
        status: 'terminated',
        terminatedAt: now,
      },
    })

    const billableMinutes =
      context.instance.startedAt && now.getTime() > context.instance.startedAt.getTime()
        ? Math.max(1, Math.ceil((now.getTime() - context.instance.startedAt.getTime()) / 60_000))
        : 0

    if (billableMinutes > 0) {
      await recordExecutionUsage(tx, {
        actorId: context.instance.launchedByActorId,
        actorType: context.instance.launchedByActorType,
        agentId: context.instance.agentId,
        channelId: context.instance.channelId,
        instanceId: context.instance.id,
        metadata: {
          terminatedAt: now.toISOString(),
          ...(terminationMetadata ?? {}),
        },
        meterType: 'uptime_min',
        organizationId: context.instance.organizationId,
        projectId: context.instance.projectId,
        quantity: billableMinutes,
        runId: context.instance.runId,
        teamId: context.instance.teamId,
        templateId: context.instance.template.id,
        templatePricingConfig: context.instance.template.pricingConfig,
        workflowRunId: context.instance.workflowRunId,
        workflowStepRunId: context.instance.workflowStepRunId,
      })
    }
  })

  await maybeContinueWorkflowForInstance(prisma, {
    instance: context.instance,
    output: buildWorkflowInstanceOutput({
      instanceId: context.instance.id,
      metadata: {
        ...asObject(context.instance.metadata),
        terminationRequestedAt: null,
        ...(terminationMetadata ?? {}),
      },
      providerInstanceRef: context.instance.providerInstanceRef,
      status: 'terminated',
    }),
    success: false,
    summary: 'Execution environment was terminated.',
  })

  return true
}

export const expireExecutionLeases = async (
  prisma: PrismaClient,
): Promise<number> => {
  const now = new Date()
  const expiredLeases = await prisma.executionLease.findMany({
    where: {
      expiresAt: {
        lt: now,
      },
      status: {
        in: ['issued', 'acknowledged'],
      },
    },
    select: {
      id: true,
      instanceId: true,
    },
  })

  let expiredCount = 0
  for (const lease of expiredLeases) {
    const result = await prisma.$transaction(async (tx) => {
      const updatedLease = await tx.executionLease.updateMany({
        where: {
          expiresAt: {
            lt: now,
          },
          id: lease.id,
          status: {
            in: ['issued', 'acknowledged'],
          },
        },
        data: {
          completedAt: now,
          status: 'expired',
        },
      })
      if (updatedLease.count === 0) {
        return false
      }

      await tx.executionEnvironmentInstance.updateMany({
        where: {
          id: lease.instanceId,
          status: {
            in: ['pending', 'provisioning'],
          },
        },
        data: {
          errorMessage: 'EXECUTION_LEASE_EXPIRED',
          lastHeartbeatAt: now,
          status: 'failed',
        },
      })

      return true
    })

    if (result) {
      const terminalInstance = await loadWorkflowInstanceState(prisma, lease.instanceId)
      if (terminalInstance?.status === 'failed') {
        await maybeContinueWorkflowForInstance(prisma, {
          instance: terminalInstance,
          output: buildWorkflowInstanceOutput({
            errorMessage: terminalInstance.errorMessage,
            instanceId: terminalInstance.id,
            metadata: terminalInstance.metadata,
            providerInstanceRef: terminalInstance.providerInstanceRef,
            status: terminalInstance.status,
          }),
          success: false,
          summary: terminalInstance.errorMessage ?? 'Execution environment lease expired.',
        })
      }
      expiredCount += 1
    }
  }

  return expiredCount
}
