import { executorOperationLabel } from './executor-presentation'

/** Human consequences of the exact structured change that will be confirmed. */
export const executorChangePresentation = (
  change: Record<string, unknown>,
  agentName?: string,
  personName?: string,
): { title: string; description: string; action: string; reviewable: boolean } => {
  if (change.kind === 'lifecycle') {
    const states: Record<string, [string, string]> = {
      pause: ['Pause executor', 'Stops current work and prevents new work until you resume this machine.'],
      resume: ['Resume executor', 'Allows new work on this machine. Stopped sessions will not restart.'],
      revoke: ['Disconnect executor', 'Stops all work and revokes this pairing. Pair the machine again to use it. Its history stays in Nessie.'],
      remove: ['Delete executor', 'Stops all work, revokes this pairing and removes the machine from Executors. Pair it again to use it. Its history stays in Nessie.'],
      drain: ['Stop accepting work', 'Stops current sessions and prevents new work. This state cannot be resumed.'],
    }
    const value = typeof change.action === 'string' ? states[change.action] : undefined
    if (value) return { title: value[0], description: value[1], action: value[0], reviewable: true }
  }
  if (change.kind === 'descriptor_review') {
    const active = change.status === 'active'
    return {
      title: active ? 'Approve machine changes' : 'Disable machine permissions',
      description: active ? 'These are the permissions agents will be allowed to use.' : 'Agents will no longer be able to use these permissions.',
      action: active ? 'Approve changes' : 'Disable permissions', reviewable: true,
    }
  }
  if (['agent_executor_access', 'agent_executor_grant', 'agent_operation_grant'].includes(String(change.kind))) {
    const allowed = change.state === 'allowed'
    const operation = typeof change.operationKey === 'string' ? executorOperationLabel(change.operationKey).toLowerCase() : null
    return {
      title: allowed ? 'Add agent' : 'Remove agent access',
      description: agentName ? allowed
        ? `${agentName} will be able to ${operation ?? 'use this machine’s approved permissions'}.`
        : `${agentName} will no longer be allowed to ${operation ?? 'use this machine'}.`
        : 'The selected agent could not be loaded. Close this change and try again.',
      action: allowed ? 'Allow access' : 'Remove access', reviewable: Boolean(agentName),
    }
  }
  if (change.kind === 'private_assignment') {
    const value = change.action === 'set' ? change.assignment : change.principal
    const assignment = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const name = assignment.principalKind === 'agent' ? agentName : personName
    const remove = change.action === 'remove'
    return {
      title: remove ? 'Remove machine access' : 'Change machine access',
      description: name ? remove ? `${name} will lose access to this machine.`
        : assignment.role === 'admin' ? `${name} will be able to manage this machine and who can use it.`
          : `${name} will be able to use this machine.`
        : 'The selected person or agent could not be loaded. Close this change and try again.',
      action: remove ? 'Remove access' : 'Allow access', reviewable: Boolean(name),
    }
  }
  if (change.kind === 'standing_policy') {
    // A trigger's standing machine access: the plain-words card it was prepared
    // with says everything it covers; this names it and what it means.
    const summary = change.summary && typeof change.summary === 'object'
      ? change.summary as { machineLabels?: unknown; triggerName?: unknown }
      : {}
    const labels = Array.isArray(summary.machineLabels)
      ? summary.machineLabels.filter((label): label is string => typeof label === 'string')
      : []
    const machines = labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
    const trigger = typeof summary.triggerName === 'string' ? summary.triggerName : null
    return {
      title: 'Allow standing machine access',
      description: agentName && trigger && machines
        ? `${agentName} will work tickets from “${trigger}” on ${machines}. Anyone who can edit that board can `
          + 'then make Claude run commands there as you, with your git and coding-agent login, within the limits '
          + 'and instructions you were shown.'
        : 'The agent could not be loaded. Close this change and try again.',
      action: 'Allow machine access',
      reviewable: Boolean(agentName && trigger && machines),
    }
  }
  return { title: 'Review machine change', description: 'This change cannot be reviewed in this version of Nessie.', action: 'Confirm', reviewable: false }
}
