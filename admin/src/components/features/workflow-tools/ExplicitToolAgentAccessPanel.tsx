import { useState } from 'react'
import type { AgentToolPolicyTarget } from '@nessie/schemas'

import {
  useSetAgentToolPolicyEntry,
  type McpToolRegistryRecord,
} from '../../../facades/tool-grants/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { Row, RowList } from '../../shared/RowList'
import { Pill } from '../../primitives/Pill'
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
    <Row
      subtitle={target.role}
      title={
        <span className="flex items-center gap-2">
          <span>{target.name}</span>
          {target.agentKind === 'personal_assistant' ? (
            <Pill height="control" tone="accent">Personal Assistant</Pill>
          ) : null}
        </span>
      }
      trailing={
        <div className={setPolicy.isPending ? 'opacity-50' : ''}>
          <Switch
            checked={checked}
            disabled={updaterManaged}
            label={`${checked ? 'Revoke' : 'Grant'} ${tool.label} for ${target.name}`}
            onChange={toggle}
          />
        </div>
      }
    >
      {error ? <FormError className="mt-1">{error}</FormError> : null}
      {updaterManaged ? (
        <div className="mt-1 text-[11px] text-[color:var(--tx3)]">
          Managed by an active Deep Water grant. Revoke the dependent
          research tools in Integrations first.
        </div>
      ) : null}
    </Row>
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
    return <EmptyState>No editable agents yet.</EmptyState>
  }

  return (
    <div className="grid gap-2">
      <div className="text-xs text-[color:var(--tx3)]">
        {grantedCount} of {targets.length} agents explicitly granted
      </div>
      <RowList label="Explicit agent access">
        {targets.map((target) => (
          <ExplicitPolicyRow
            deepWaterDependencyPolicyKeys={deepWaterDependencyPolicyKeys}
            key={target.id}
            target={target}
            tool={tool}
          />
        ))}
      </RowList>
      <p className="text-xs leading-5 text-[color:var(--tx3)]">
        Explicit-grant tools stay off unless this exact policy entry is on.
        Install scope and tenancy checks still apply at runtime.
      </p>
    </div>
  )
}
