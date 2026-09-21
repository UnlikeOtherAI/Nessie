import { useState } from 'react'
import type { ExecutorDescriptorRevisionView } from '../../../facades/executors/local-mcp'
import {
  useConfirmExecutorAccessChange,
  useConfirmExecutorWorkspacePromotion,
  useExecutorAccessChange,
  useExecutorWorkspacePromotion,
  useRejectExecutorAccessChange,
  useRejectExecutorWorkspacePromotion,
} from '../../../facades/executors/hooks'
import { ExecutorGrantedSuite } from './ExecutorGrantedSuite'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { ExecutorReviewedPolicy } from './ExecutorReviewedPolicy'
import { useAgents } from '../../../facades/agents/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { executorChangePresentation } from './executor-change-presentation'
import { useExecutorAccess } from '../../../facades/executors/hooks'

/**
 * The two one-time confirmations, as modals.
 *
 * Both are reached two ways — prepared on the executor's own detail screen, or
 * opened from a Personal Assistant link that names the change in the query and
 * carries its token in the fragment — so both live in components the list page
 * and the detail page can each mount. The token is never put in the address
 * these components control: it arrives as a prop and stays in memory.
 */

const MISSING_ACCESS_TOKEN =
  'The confirmation token is missing. Recreate the change from this page or reopen the '
  + 'Personal Assistant review link.'

const MISSING_PROMOTION_TOKEN =
  'The confirmation token is missing. Prepare the promotion again from your reviewed drafts.'

type ExecutorAccessChangeDialogProps = {
  accessChangeId: string
  confirmationToken: string | null
  /**
   * The revisions loaded for the executor this change belongs to, where the
   * caller has them. Omitted, the reviewed-policy block renders nothing rather
   * than half of somebody else's descriptor.
   */
  descriptorRevisions?: readonly ExecutorDescriptorRevisionView[]
  onClose: () => void
  open: boolean
}

export const ExecutorAccessChangeDialog = ({
  accessChangeId,
  confirmationToken,
  descriptorRevisions,
  onClose,
  open,
}: ExecutorAccessChangeDialogProps) => {
  const changeQuery = useExecutorAccessChange(open ? accessChangeId : undefined)
  const change = changeQuery.data
  const confirmChange = useConfirmExecutorAccessChange()
  const rejectChange = useRejectExecutorAccessChange()
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = confirmChange.isPending || rejectChange.isPending
  const agents = useAgents({ scope: 'all' })
  const users = useUsers(open)
  const executorAccess = useExecutorAccess(change?.executorId)
  const terms = change?.change ?? {}
  const principal = terms.assignment ?? terms.principal
  const assignment = principal && typeof principal === 'object' ? principal as Record<string, unknown> : {}
  const agentId = typeof terms.agentId === 'string' ? terms.agentId : assignment.agentId
  const copy = executorChangePresentation(terms,
    agents.data?.find((agent) => agent.id === agentId)?.name,
    users.data?.find((user) => user.id === assignment.userId)?.displayName)
  const unavailable = change?.requiresFreshVerification && change.verificationMethod !== 'password'
  const revisions = executorAccess.data?.executorId === change?.executorId
    ? executorAccess.data?.descriptorRevisions : descriptorRevisions
  const policyFound = terms.kind !== 'descriptor_review' || revisions?.some((revision) => revision.revision === terms.revision)
  const latest = [...(revisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  const grantReady = !(['agent_executor_access', 'agent_executor_grant'].includes(String(terms.kind)) && terms.state === 'allowed')
    || latest?.reviewStatus === 'active'

  const close = () => {
    setCurrentPassword('')
    setError(null)
    onClose()
  }

  const confirm = async () => {
    if (!change || !confirmationToken) return
    setError(null)
    try {
      await confirmChange.mutateAsync({
        accessChangeId: change.accessChangeId,
        confirmationToken,
        ...(change.requiresFreshVerification ? { currentPassword } : {}),
      })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to confirm access change.')
    }
  }

  const reject = async () => {
    if (!change || !confirmationToken) return
    setError(null)
    try {
      await rejectChange.mutateAsync({
        accessChangeId: change.accessChangeId,
        confirmationToken,
      })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reject access change.')
    }
  }

  return (
    <Dialog
      dismissDisabled={pending}
      onClose={close}
      open={open}
      size="lg"
      title={copy.title}
    >
      <QueryState
        className="py-6"
        errorLabel="This prepared change could not be loaded. It may have expired."
        loadingLabel="Loading prepared change…"
        query={changeQuery}
      >
        {() => change ? (
          <div className="grid gap-3">
            <p className="text-sm text-[color:var(--tx2)]">{copy.description}</p>
            <ExecutorGrantedSuite change={change.change} executorId={change.executorId} />
            <ExecutorReviewedPolicy
              change={change.change}
              {...(revisions ? { descriptorRevisions: revisions } : {})}
            />
            {!policyFound ? <FormError>
              The machine’s permissions could not be loaded. Close this change and try again.
            </FormError> : null}
            <FormError>{confirmationToken ? undefined : MISSING_ACCESS_TOKEN}</FormError>
            {unavailable ? <FormError>
              Your sign-in provider does not yet support the extra identity check needed for this change.
            </FormError> : null}
            {change.requiresFreshVerification && !unavailable ? (
              <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
                Confirm with current password
                <input
                  className="admin-input"
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  type="password"
                  value={currentPassword}
                />
              </label>
            ) : null}
            <FormError>{error}</FormError>
            <FormActions>
              <button
                className="admin-button admin-button-secondary"
                disabled={!confirmationToken || pending}
                onClick={() => void reject()}
                type="button"
              >
                Cancel change
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={!confirmationToken || pending || Boolean(unavailable) || !copy.reviewable || !policyFound || !grantReady || change.status !== 'pending'}
                onClick={() => void confirm()}
                type="button"
              >
                {copy.action}
              </button>
            </FormActions>
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  )
}

type ExecutorPromotionDialogProps = {
  confirmationToken: string | null
  onClose: () => void
  open: boolean
  promotionId: string
}

export const ExecutorPromotionDialog = ({
  confirmationToken,
  onClose,
  open,
  promotionId,
}: ExecutorPromotionDialogProps) => {
  const promotionQuery = useExecutorWorkspacePromotion(open ? promotionId : undefined)
  const promotion = promotionQuery.data
  const confirmPromotion = useConfirmExecutorWorkspacePromotion()
  const rejectPromotion = useRejectExecutorWorkspacePromotion()
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = confirmPromotion.isPending || rejectPromotion.isPending

  const close = () => {
    setCurrentPassword('')
    setError(null)
    onClose()
  }

  const confirm = async () => {
    if (!promotion || !confirmationToken) return
    setError(null)
    try {
      await confirmPromotion.mutateAsync({
        confirmationToken,
        currentPassword,
        promotionId: promotion.promotionId,
      })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to promote workspace draft.')
    }
  }

  const reject = async () => {
    if (!promotion || !confirmationToken) return
    setError(null)
    try {
      await rejectPromotion.mutateAsync({ confirmationToken, promotionId: promotion.promotionId })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to reject workspace promotion.')
    }
  }

  return (
    <Dialog
      description="A promotion writes the host workspace only if the daemon reconstructs the same manifest digest and the host root is unchanged."
      dismissDisabled={pending}
      onClose={close}
      open={open}
      size="lg"
      title="Confirm workspace promotion"
    >
      <QueryState
        className="py-6"
        errorLabel="This prepared promotion could not be loaded. It may have expired."
        loadingLabel="Loading prepared promotion…"
        query={promotionQuery}
      >
        {() => promotion ? (
          <div className="grid gap-3">
            <p className="text-xs text-[color:var(--tx3)]">
              This promotes {promotion.changeCount} reviewed change{promotion.changeCount === 1 ? '' : 's'}.
              It expires at {promotion.expiresAt}.
            </p>
            <code className="block overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx2)]">{promotion.manifestDigest}</code>
            <FormError>{confirmationToken ? undefined : MISSING_PROMOTION_TOKEN}</FormError>
            <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
              Confirm with current password
              <input
                className="admin-input"
                onChange={(event) => setCurrentPassword(event.target.value)}
                type="password"
                value={currentPassword}
              />
            </label>
            <FormError>{error}</FormError>
            <FormActions>
              <button
                className="admin-button admin-button-secondary"
                disabled={!confirmationToken || pending}
                onClick={() => void reject()}
                type="button"
              >
                Reject
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={!confirmationToken || pending}
                onClick={() => void confirm()}
                type="button"
              >
                Confirm promotion
              </button>
            </FormActions>
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  )
}
