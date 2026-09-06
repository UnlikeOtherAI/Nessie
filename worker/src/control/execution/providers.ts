import {
  assertLocalOnlyCapability,
  DOCKER_EXECUTION_PROVIDER,
  localOnlyCapabilityMessage,
  localOnlyGateMode,
} from '@nessie/config'
import { probeDocker, provisionDocker, terminateDocker } from './docker-provider.js'
import { probeGcloud, provisionGcloud, terminateGcloud } from './gcloud-provider.js'
import type {
  ExecutionProvider,
  ProviderProbe,
  ProviderProvisionResult,
  ProvisioningContext,
  TerminationContext,
} from './types.js'

/**
 * The `docker` provider is host-affine: it shells out to this instance's own
 * daemon, and its terminate job is routed to whichever worker claims it
 * (audit 6.3/8.2). Outside `local` mode it is refused here rather than at
 * configuration load, because the provider is a column on
 * `execution_environment_templates` — per-organisation data, which
 * `loadConfig` cannot see. This is the one place every probe, provision and
 * terminate passes through. See docs/standards/horizontal-scaling.md,
 * invariant 7.
 *
 * The refusal is not symmetric, and `terminateProviderInstance` below says why.
 */
const dockerRefusal = (): string | null => {
  const mode = localOnlyGateMode()
  return mode === 'local'
    ? null
    : localOnlyCapabilityMessage(mode, DOCKER_EXECUTION_PROVIDER)
}

const assertDockerAllowed = (): void => {
  assertLocalOnlyCapability(localOnlyGateMode(), DOCKER_EXECUTION_PROVIDER)
}

export const probeProvider = async (provider: ExecutionProvider): Promise<ProviderProbe> => {
  if (provider === 'docker') {
    // The probe answers rather than throws: it runs in the boot-time runner
    // registration loop over every provider, and a refusal there is a fact
    // about this deployment ("offline, and here is why"), not a boot failure.
    const refusal = dockerRefusal()
    if (refusal !== null) {
      return {
        available: false,
        capabilities: ['container'],
        metadata: { error: refusal, source: 'worker' },
      }
    }
    return probeDocker()
  }

  return probeGcloud()
}

export const provisionProviderInstance = async (
  context: ProvisioningContext,
): Promise<ProviderProvisionResult> => {
  if (context.instance.template.provider === 'docker') {
    assertDockerAllowed()
    return provisionDocker(context)
  }

  return provisionGcloud(context)
}

/**
 * Deliberately ungated, unlike `provisionProviderInstance` above — the next
 * reader will expect the two to match, and they must not.
 *
 * Refuse to *create* single-host resources; never refuse to *clean up* the ones
 * that exist. Terminating is always the safe direction. An operator who mounted
 * the Docker socket into the worker before upgrading has live containers and
 * `ready` rows; if terminate threw here, the job would be claimed, the
 * assertion would fire, the container would keep running and the row would
 * never leave `terminating` — an upgrade that strands exactly what it was
 * meant to stop. The probe still reports the provider offline and provision
 * still throws, so nothing new is placed; draining what already exists is all
 * that is left for `docker` on such a deployment.
 */
export const terminateProviderInstance = async (
  context: TerminationContext,
): Promise<Record<string, unknown>> => {
  if (context.instance.template.provider === 'docker') {
    return terminateDocker(context)
  }

  return terminateGcloud(context)
}
