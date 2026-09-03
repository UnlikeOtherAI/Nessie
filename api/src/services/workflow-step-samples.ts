/**
 * §5 `stepSamples`: the designer's persisted per-step output samples from
 * the last successful test run — a **sensitive-data store**, not a cache of
 * convenience. The rules the plan attaches to it:
 *
 * - **W0 redaction on write.** Successful tool outputs routinely contain
 *   customer data; nothing a tainted `secret_*` ref could survive in lands
 *   here (values pass `redactWorkflowSecretValues` before persistence).
 * - **Installation provenance.** The payload records the installation and
 *   run the samples came from, so a template copied across installations
 *   cannot present another installation's data as its own shape.
 * - **Size quota.** The whole serialized store is capped; a run whose
 *   samples exceed the quota is simply not persisted (the run detail still
 *   serves its redacted step artifacts — the designer loses only the
 *   across-reopen convenience, never data).
 * - **Retention.** Samples past the retention window are treated as absent
 *   on read and pruned on the next write; a designer session months later
 *   must re-run to see fresh shapes rather than read stale customer data.
 * - **Deleted with the template.** `workflow_templates.step_samples` is a
 *   column, so the template's cascade owns its lifecycle.
 * - **Entitlement-checked before being served.** The store is only ever
 *   read through `getWorkflowTemplateStepSamples`, which the route calls
 *   after `requireOwner` — the same entitlement as every other template
 *   read. Samples are never embedded in the generic template record.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  WORKFLOW_JMESPATH_OUTPUT_MAX_BYTES,
  collectWorkflowTaintedRefs,
  redactWorkflowSecretValues,
} from '@nessie/team-admin'

export const WORKFLOW_STEP_SAMPLES_MAX_BYTES = WORKFLOW_JMESPATH_OUTPUT_MAX_BYTES
export const WORKFLOW_STEP_SAMPLES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class WorkflowStepSamplesError extends Error {
  readonly code: 'INSTALLATION_NOT_FOUND' | 'TEMPLATE_NOT_FOUND'

  constructor(code: WorkflowStepSamplesError['code']) {
    super(`WORKFLOW_STEP_SAMPLES_${code}`)
    this.code = code
  }
}

export type WorkflowStepSamplesStore = {
  /** The template version whose run produced these samples. */
  templateVersion: number
  /** §5 provenance: the installation and run the samples came from. */
  workflowInstallationId: string
  workflowRunId: string
  capturedAt: string
  /** Step id → that step's redacted output. */
  steps: Record<string, unknown>
}

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

export const parseWorkflowStepSamples = (value: unknown): WorkflowStepSamplesStore | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const steps = record['steps']
  if (
    typeof record['templateVersion'] !== 'number' ||
    typeof record['workflowInstallationId'] !== 'string' ||
    typeof record['workflowRunId'] !== 'string' ||
    typeof record['capturedAt'] !== 'string' ||
    !steps ||
    typeof steps !== 'object' ||
    Array.isArray(steps)
  ) {
    return null
  }
  // Retention: a stale store reads as absent. Pruning happens on the next
  // write; nothing here mutates during a read.
  const capturedAt = Date.parse(record['capturedAt'])
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > WORKFLOW_STEP_SAMPLES_RETENTION_MS) {
    return null
  }
  return {
    templateVersion: record['templateVersion'],
    workflowInstallationId: record['workflowInstallationId'],
    workflowRunId: record['workflowRunId'],
    capturedAt: record['capturedAt'],
    steps: steps as Record<string, unknown>,
  }
}

/**
 * Served to the designer after the route's owner check — entitlement is the
 * route's, so the service takes the organization as the one scope it always
 * enforces. Samples are redacted AGAIN on the way out: a store written
 * before a binding became tainted must not resurrect the value.
 */
export const getWorkflowTemplateStepSamples = async (
  prisma: PrismaClient,
  organizationId: string,
  workflowTemplateId: string,
): Promise<WorkflowStepSamplesStore | null> => {
  const template = await prisma.workflowTemplate.findFirst({
    where: { id: workflowTemplateId, organizationId },
    select: { stepSamples: true },
  })
  const parsed = parseWorkflowStepSamples(template?.stepSamples)
  if (!parsed) {
    return null
  }
  return {
    ...parsed,
    steps: redactWorkflowSecretValues(
      parsed.steps,
      collectWorkflowTaintedRefs(parsed.steps),
    ) as Record<string, unknown>,
  }
}

export type RecordWorkflowStepSamplesResult =
  | 'recorded'
  // Over the quota: the convenience is lost, the run is not.
  | 'quota_exceeded'

/**
 * Persist the last successful designer test run's per-step output. Only
 * completed steps contribute; the whole store must fit the quota. Redaction
 * uses the installation's taint set, so the boundary is the same one the
 * executor enforced while producing the outputs.
 */
export const recordWorkflowStepSamples = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    stepOutputs: Record<string, unknown>
    workflowInstallationId: string
    workflowRunId: string
    workflowTemplateId: string
  },
): Promise<RecordWorkflowStepSamplesResult> => {
  const installation = await prisma.workflowInstallation.findFirst({
    where: {
      id: input.workflowInstallationId,
      organizationId,
      workflowTemplateId: input.workflowTemplateId,
    },
    select: { resolvedBindings: true },
  })
  if (!installation) {
    throw new WorkflowStepSamplesError('INSTALLATION_NOT_FOUND')
  }

  const template = await prisma.workflowTemplate.findFirst({
    where: { id: input.workflowTemplateId, organizationId },
    select: { version: true },
  })
  if (!template) {
    throw new WorkflowStepSamplesError('TEMPLATE_NOT_FOUND')
  }

  const taintedRefs = collectWorkflowTaintedRefs(installation.resolvedBindings)
  const store: WorkflowStepSamplesStore = {
    templateVersion: template.version,
    workflowInstallationId: input.workflowInstallationId,
    workflowRunId: input.workflowRunId,
    capturedAt: new Date().toISOString(),
    steps: redactWorkflowSecretValues(
      input.stepOutputs,
      taintedRefs,
    ) as Record<string, unknown>,
  }

  let serialized: string
  try {
    serialized = JSON.stringify(store)
  } catch {
    return 'quota_exceeded'
  }
  if (byteLength(serialized) > WORKFLOW_STEP_SAMPLES_MAX_BYTES) {
    return 'quota_exceeded'
  }

  const updated = await prisma.workflowTemplate.updateMany({
    where: { id: input.workflowTemplateId, organizationId },
    data: { stepSamples: store as unknown as Prisma.InputJsonValue },
  })
  if (updated.count === 0) {
    throw new WorkflowStepSamplesError('TEMPLATE_NOT_FOUND')
  }
  return 'recorded'
}
