// Workflow cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

const workflowRunsRoot = ['workflow-runs'] as const

export const workflowKeys = {
  failedRuns: [...workflowRunsRoot, 'failed'] as const,
  installationRuns: (installationId?: string) =>
    ['workflow-installations', installationId, 'runs'] as const,
  installations: ['workflow-installations'] as const,
  installationsForChannel: (channelId?: string) =>
    ['workflow-installations', channelId ?? null] as const,
  installationTriggers: (installationId?: string) =>
    ['workflow-installations', installationId, 'triggers'] as const,
  run: (workflowRunId?: string) => [...workflowRunsRoot, workflowRunId] as const,
  runs: workflowRunsRoot,
  template: (workflowTemplateId?: string) =>
    ['workflow-templates', workflowTemplateId] as const,
  templates: ['workflow-templates'] as const,
  templateStepSamples: (workflowTemplateId?: string) =>
    ['workflow-templates', workflowTemplateId, 'step-samples'] as const,
}
