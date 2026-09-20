import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentModelOption } from '../../../lib/api-client'
import {
  useConfirmLocalInferenceBinding,
  useLocalInferenceHosts,
  usePrepareLocalInferenceBinding,
} from '../../../facades/local-inference/hooks'
import { isDesktopApp } from '../../../lib/desktop'
import { signLocalInferenceBindingConsent } from '../../../lib/local-inference-desktop'
import { Notice } from '../../primitives/Notice'

type LocalModelBindingApprovalProps = {
  agentId: string | undefined
  disabled: boolean
  option: AgentModelOption | null
  onBindingChange: (bindingId: string | null) => void
}

/**
 * The one approval door between selecting an observed local model and Designer
 * Save. A model row alone never activates an agent; a native or executor-held
 * key must first approve this exact host, model and agent.
 */
export const LocalModelBindingApproval = ({
  agentId,
  disabled,
  option,
  onBindingChange,
}: LocalModelBindingApprovalProps) => {
  const hosts = useLocalInferenceHosts()
  const prepare = usePrepareLocalInferenceBinding()
  const confirm = useConfirmLocalInferenceBinding()
  const [prepared, setPrepared] = useState<{ bindingId: string; challengeId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isLocal = option?.source === 'local'
  const host = useMemo(
    () => hosts.data?.hosts.find((candidate) => candidate.id === option?.localInferenceHostId) ?? null,
    [hosts.data?.hosts, option?.localInferenceHostId],
  )

  if (!isLocal) return null
  if (!agentId) {
    return (
      <Notice tone="neutral">
        Create this agent with a hosted model first. Then reopen its Model section to approve a model on your own
        computer.
      </Notice>
    )
  }
  if (!option.localInferenceHostId || !option.localManifestDigest || !host) {
    return <Notice tone="warning">This local model is no longer available. Refresh Connected accounts and choose it again.</Notice>
  }

  const prepareBinding = async () => {
    setError(null)
    try {
      const next = await prepare.mutateAsync({
        agentId,
        hostId: option.localInferenceHostId,
        manifestDigest: option.localManifestDigest,
        modelName: option.model,
      })
      setPrepared({ bindingId: next.bindingId, challengeId: next.challengeId })
      if (host.transport === 'desktop' && isDesktopApp()) {
        const signature = await signLocalInferenceBindingConsent({
          challengeId: next.challengeId,
        })
        await confirm.mutateAsync({ agentId, challengeId: next.challengeId, signature })
        onBindingChange(next.bindingId)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Local model approval could not be prepared.')
    }
  }

  const isDesktopHost = host.transport === 'desktop'
  const executorPath = host.executorId ? `/agents/executors/${host.executorId}` : '/agents/executors'
  return (
    <div className="grid gap-3 border-t border-[color:var(--sep)] pt-3" data-testid="local-model-approval">
      <Notice tone={prepared && (!isDesktopHost || Boolean(confirm.data)) ? 'success' : 'neutral'}>
        {prepared && isDesktopHost && confirm.data
          ? 'This computer approved the selected local model. Save the agent to activate it.'
          : 'The selected model stays on your own computer. Approve this exact agent and model before Save can activate it.'}
      </Notice>
      {!prepared ? (
        <button
          className="admin-button admin-button-secondary w-fit"
          disabled={disabled || prepare.isPending}
          onClick={() => void prepareBinding()}
          type="button"
        >
          {prepare.isPending ? 'Preparing approval…' : 'Approve local model'}
        </button>
      ) : isDesktopHost && !isDesktopApp() ? (
        <p className="text-sm text-[color:var(--tx2)]">
          Open Nessie Desktop on the computer that runs Ollama to approve this binding; a browser cannot use its key.
        </p>
      ) : host.transport === 'executor' ? (
        <div className="grid gap-2 text-sm text-[color:var(--tx2)]">
          <p>Approve this binding from the paired executor, then return here to allow the final Designer Save.</p>
          <Link className="admin-button admin-button-secondary w-fit" to={executorPath}>Open executor controls</Link>
          <code className="overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx)]">
            nessie-executor local-inference-confirm --challenge {prepared.challengeId} --binding {prepared.bindingId}
          </code>
          <button
            className="admin-button admin-button-secondary w-fit"
            disabled={disabled}
            onClick={() => onBindingChange(prepared.bindingId)}
            type="button"
          >
            I approved it in the executor
          </button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
