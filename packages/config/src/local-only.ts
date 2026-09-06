import type { NessieMode } from './index.js'

/**
 * The capabilities that only work while ONE process owns the machine — its
 * disk, its Docker daemon, its files.
 *
 * Outside `local` mode Nessie runs N copies of the API and the worker
 * (`docs/standards/horizontal-scaling.md`, invariant 7), and every capability
 * listed below fails by *appearing* to work: the upload lands, the container is
 * recorded terminated, the file is written — on one instance, and nowhere the
 * next call reaches. Each is therefore refused, loudly, naming the setting and
 * the mode.
 *
 * `local` keeps all of them. It is the single-instance developer path, and
 * there the API embeds the worker in its own process: one disk, one daemon.
 *
 * Only the first is genuinely *configuration*, so only the first can be refused
 * in `loadConfig`. The other two are per-organisation database rows — the
 * execution provider is a column on `execution_environment_templates`, the
 * builtins' `allowedRoots` a column on `tool_registry_entries` — so they are
 * refused at their own chokepoints in the worker. Their descriptors live here
 * anyway, so the inventory invariant 7 forbids is one list in one file.
 */
export type LocalOnlyCapability = {
  /** What the operator set, named the way they set it. */
  setting: string
  /** Why a second instance breaks it. One sentence, concrete. */
  because: string
  /** What to do instead. One sentence, imperative. */
  instead: string
}

export class SingleInstanceCapabilityError extends Error {
  override readonly name = 'SingleInstanceCapabilityError'

  constructor(message: string) {
    super(message)
  }
}

/**
 * The refusal as prose, split from the assert because one caller — the
 * execution-runner probe — has to answer "unavailable, and here is why"
 * instead of throwing, and the reason it records must be the same sentence a
 * boot failure would have printed.
 */
export const localOnlyCapabilityMessage = (
  mode: NessieMode,
  capability: LocalOnlyCapability,
): string =>
  `${capability.setting} is not allowed in ${mode} mode: ${capability.because}`
  + ` ${capability.instead}`
  + ' Only `local` mode, which runs a single API process with the worker'
  + ' embedded, may use it.'

export const assertLocalOnlyCapability = (
  mode: NessieMode,
  capability: LocalOnlyCapability,
): void => {
  if (mode === 'local') {
    return
  }

  throw new SingleInstanceCapabilityError(localOnlyCapabilityMessage(mode, capability))
}

export const FILESYSTEM_STORAGE: LocalOnlyCapability = {
  setting: 'NESSIE_STORAGE_PROVIDER=filesystem (storage.provider)',
  because:
    "the filesystem backend writes uploads under the instance's own working"
    + ' directory, so a file uploaded through one API instance 404s from every'
    + ' other and the whole store is discarded when a container is replaced —'
    + ' and the API and the worker are already separate containers with no'
    + ' shared volume.',
  instead:
    'Set NESSIE_STORAGE_PROVIDER=s3 together with NESSIE_STORAGE_BUCKET,'
    + ' NESSIE_STORAGE_ENDPOINT and credentials; production runs MinIO this way.',
}

export const DOCKER_EXECUTION_PROVIDER: LocalOnlyCapability = {
  setting: 'The `docker` execution environment provider',
  because:
    "it shells out to this instance's own Docker daemon, so a container"
    + ' provisioned here cannot be inspected or terminated from another'
    + ' instance — and terminate swallows "No such container", recording the'
    + ' environment as terminated while it keeps running and billing.',
  instead:
    'Create execution environment templates with provider `gcloud`, which'
    + ' addresses instances through an API every instance can reach.',
}

export const FILESYSTEM_BUILTIN_TOOLS: LocalOnlyCapability = {
  setting: 'The `file_read`, `file_write` and `file_glob` builtin tools',
  because:
    "they read and write the worker instance's own disk under the"
    + ' `allowedRoots` an operator configured, so a file one run writes is'
    + ' invisible to the next run on another worker and is discarded when the'
    + ' container is replaced.',
  instead:
    'Reach files through the knowledge base or an MCP server every worker can'
    + ' call, both of which store content where a second instance can read it.',
}
