import { useState } from 'react'
import type { AgentToolPolicyTarget } from '@nessie/schemas'

import {
  useSetAgentToolPolicyEntry,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'
import { StatusPill } from '../../primitives/StatusPill'
import { Switch } from '../../primitives/Switch'

type ExplicitToolAgentAccessPanelProps = {
  deepWaterDependencyPolicyKeys: string[]
  targets: AgentToolPolicyTarget[]
  tool: McpToolRegistryRecord
}

const ExplicitPolicyRow = ({
  target,
  tool,
  deepWaterDependencyPolicyKeys,
}: {
  deepWaterDependencyPolicyKeys: string[]
  target: AgentToolPolicyTarget
  tool: McpToolRegistryRecord
}) => {
  const setPolicy = useSetAgentToolPolicyEntry()
  const baseline = target.toolPolicy[tool.policyKey] === true
  const [override, setOverride] = useState<boolean>()
  const [error, setError] = useState<string | null>(null)
  const checked = override ?? baseline
  const updaterManaged =
    tool.toolId === 'deep_water_run_update'
    && baseline
    && (
      Object.entries(target.toolPolicy).some(
        ([key, enabled]) =>
          enabled && key.startsWith('__nessie_deep_water_bundle__:'),
      )
      || deepWaterDependencyPolicyKeys.some(
        (key) => target.toolPolicy[key] === true,
      )
    )

  const toggle = (enabled: boolean) => {
    if (setPolicy.isPending) return
    setError(null)
    setOverride(enabled)
    setPolicy.mutate(
      {
        agentId: target.id,
        enabled,
        toolRegistryEntryId: tool.id,
      },
      {
        onError: (caught) => {
          setOverride(undefined)
          setError(
            caught instanceof Error
              ? caught.message
              : 'Failed to change agent access',
          )
        },
        onSuccess: () => setOverride(undefined),
      },
    )
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-[var(--tx)]">
          {target.name}
        </span>
        <span className="ml-2 text-xs text-[color:var(--tx3)]">
          {target.role}
        </span>
        {target.agentKind === 'personal_assistant' ? (
          <span className="ml-2">
            <StatusPill tone="accent">Personal Assistant</StatusPill>
          </span>
        ) : null}
        {error ? (
          <div
            className="mt-1 text-[11px] text-[var(--danger-text)]"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {updaterManaged ? (
          <div className="mt-1 text-[11px] text-[color:var(--tx3)]">
            Managed by an active Deep Water grant. Revoke the dependent
            research tools in Integrations first.
          </div>
        ) : null}
      </div>
      <div className={setPolicy.isPending ? 'opacity-50' : ''}>
        <Switch
          checked={checked}
          disabled={updaterManaged}
          label={`${checked ? 'Revoke' : 'Grant'} ${tool.label} for ${target.name}`}
          onChange={toggle}
        />
      </div>
    </div>
  )
}

export const ExplicitToolAgentAccessPanel = ({
  deepWaterDependencyPolicyKeys,
  targets,
  tool,
}: ExplicitToolAgentAccessPanelProps) => {
  const grantedCount = targets.filter(
    (target) => target.toolPolicy[tool.policyKey] === true,
  ).length

  if (targets.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
        No editable agents yet.
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="text-xs text-[color:var(--tx3)]">
        {grantedCount} of {targets.length} agents explicitly granted
      </div>
      <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
        {targets.map((target) => (
          <ExplicitPolicyRow
            deepWaterDependencyPolicyKeys={deepWaterDependencyPolicyKeys}
            key={target.id}
            target={target}
            tool={tool}
          />
        ))}
      </div>
      <p className="text-xs leading-5 text-[color:var(--tx3)]">
        Explicit-grant tools stay off unless this exact policy entry is on.
        Install scope and tenancy checks still apply at runtime.
      </p>
    </div>
  )
}
