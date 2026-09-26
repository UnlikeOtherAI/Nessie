import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentModelOption } from '../../../lib/api-client'
import {
  useCheckLocalInferenceBindingStatus,
  useConfirmLocalInferenceBinding,
  useLocalInferenceBindingStatus,
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
  const checkBindingStatus = useCheckLocalInferenceBindingStatus()
  const [prepared, setPrepared] = useState<{ bindingId: string; challengeId: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isLocal = option?.source === 'local'
  const localHostId = option?.localInferenceHostId
  const localManifestDigest = option?.localManifestDigest
  const host = useMemo(
    () => hosts.data?.hosts.find((candidate) => candidate.id === option?.localInferenceHostId) ?? null,
    [hosts.data?.hosts, option?.localInferenceHostId],
  )
  const bindingStatus = useLocalInferenceBindingStatus(
    agentId,
    prepared?.bindingId,
    host?.transport === 'executor',
  )

  useEffect(() => {
    if (prepared && bindingStatus.data?.status === 'consented_pending_activation') {
      onBindingChange(prepared.bindingId)
    }
  }, [bindingStatus.data?.status, onBindingChange, prepared])

  if (!isLocal) return null
  if (!agentId) {
    return (
      <Notice tone="neutral">
        Create this agent with a hosted model first. Then reopen its Model section to approve a model on your own
        computer.
      </Notice>
    )
  }
  if (!localHostId || !localManifestDigest || !host) {
    return <Notice tone="warning">This local model is no longer available. Refresh Connected accounts and choose it again.</Notice>
  }

  const prepareBinding = async () => {
    setError(null)
    try {
      const next = await prepare.mutateAsync({
        agentId,
        hostId: localHostId,
        manifestDigest: localManifestDigest,
        modelName: option.model,
      })
      setPrepared({ bindingId: next.bindingId, challengeId: next.challengeId })
      if (host.transport === 'desktop' && isDesktopApp()) {
        const signature = await signLocalInferenceBindingConsent({
          challengeId: next.challengeId,
        })
        await confirm.mutateAsync({ agentId, challengeId: next.challengeId, signature })
        const status = await checkBindingStatus.mutateAsync({ agentId, bindingId: next.bindingId })
        if (status.status !== 'consented_pending_activation') {
          throw new Error('Nessie could not confirm that this local model approval is ready to save.')
        }
        onBindingChange(next.bindingId)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Local model approval could not be prepared.')
    }
  }

  const isDesktopHost = host.transport === 'desktop'
  const executorPath = host.executorId ? `/admin/computers/${host.executorId}` : '/admin/computers'
  return (
    <div className="grid gap-3 border-t border-[color:var(--sep)] pt-3" data-testid="local-model-approval">
      <Notice tone={prepared && ((isDesktopHost && Boolean(confirm.data)) || bindingStatus.data?.status === 'consented_pending_activation') ? 'success' : 'neutral'}>
        {prepared && ((isDesktopHost && confirm.data) || bindingStatus.data?.status === 'consented_pending_activation')
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
            disabled={disabled || bindingStatus.isFetching}
            onClick={() => void bindingStatus.refetch()}
            type="button"
          >
            {bindingStatus.isFetching ? 'Checking approval…' : 'Check executor approval'}
          </button>
          {bindingStatus.data?.status === 'pending' ? (
            <p>Nessie is still waiting for this executor’s signed approval.</p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
