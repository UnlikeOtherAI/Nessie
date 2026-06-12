import { probeDocker, provisionDocker, terminateDocker } from './docker-provider.js'
import { probeGcloud, provisionGcloud, terminateGcloud } from './gcloud-provider.js'
import type {
  ExecutionProvider,
  ProviderProbe,
  ProviderProvisionResult,
  ProvisioningContext,
  TerminationContext,
} from './types.js'

export const probeProvider = async (provider: ExecutionProvider): Promise<ProviderProbe> =>
  provider === 'docker' ? probeDocker() : probeGcloud()

export const provisionProviderInstance = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> =>
  context.instance.template.provider === 'docker'
    ? provisionDocker(context)
    : provisionGcloud(context)

export const terminateProviderInstance = async (
  context: TerminationContext,
): Promise<Record<string, unknown>> =>
  context.instance.template.provider === 'docker'
    ? terminateDocker(context)
    : terminateGcloud(context)
