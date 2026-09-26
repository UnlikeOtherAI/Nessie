import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useDecideAgentAuthorization,
  usePendingAgentAuthorization,
  type AgentAccessScope,
} from '../../../facades/agent-access/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Checkbox } from '../../primitives/Checkbox'
import { CodeInput } from '../../primitives/CodeInput'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError, FormSuccess } from '../../shared/FormActions'
import { SCOPE_COPY, SCOPE_ORDER, formatCredentialDate } from './paired-agent-presentation'

type PairAgentDialogProps = {
  /** From `?code=`, the agent's own `verification_uri_complete`. */
  initialCode?: string
  onClose: () => void
  open: boolean
}

/**
 * Pairing an agent: the code, then the decision.
 *
 * It was the top half of the page, so a screen somebody opens to *review* what
 * they have lent out led with a form for lending more. It is a dialog now, and
 * it still carries both steps — a code with nothing to decide is not a pairing,
 * and the decision is the whole point of typing one.
 */
export const PairAgentDialog = ({ initialCode, onClose, open }: PairAgentDialogProps) => {
  const { t } = useTranslation('settings')
  // Held compact (no dash): the input renders the grouping, and the server
  // normalises either shape.
  const [code, setCode] = useState('')
  const [granted, setGranted] = useState<AgentAccessScope[]>([])
  const [decided, setDecided] = useState<'allowed' | 'refused' | null>(null)
  // A failed decision has to be visible: silently leaving a credential live is
  // the one outcome a person must never be left guessing at.
  const [actionError, setActionError] = useState<string | null>(null)

  const pending = usePendingAgentAuthorization(open ? code : '')
  const decide = useDecideAgentAuthorization()
  const { me } = useAuthSession()

  const requested = useMemo(
    () => pending.data?.requestedScopes ?? [],
    [pending.data?.requestedScopes],
  )

  // The agent prints a `verification_uri_complete` carrying the code, so
  // arriving from it should land on the decision, not on a form to retype it.
  useEffect(() => {
    if (open && initialCode) {
      setCode(initialCode.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    }
  }, [initialCode, open])

  // Everything asked for starts ticked. Granting *less* is the deliberate act,
  // and there is no longer a scope that inverts that: publishing left this
  // screen entirely and became an approval per document.
  useEffect(() => {
    setGranted(requested)
  }, [requested])

  // The server refuses a pairing with no active project and team, and it used
  // to do so only after the click. Saying it up front costs a person nothing;
  // finding out by pressing Allow costs them the guess about what went wrong.
  const tenantReady = Boolean(me?.context.projectId && me?.context.teamId)

  const close = () => {
    setCode('')
    setGranted([])
    setDecided(null)
    setActionError(null)
    onClose()
  }

  const submit = (approve: boolean) => {
    setActionError(null)
    decide.mutate(
      { approve, scopes: approve ? granted : [], userCode: code },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error
              ? error.message
              : t('pairedAgents.decisionFailed'),
          ),
        onSuccess: () => setDecided(approve ? 'allowed' : 'refused'),
      },
    )
  }

  return (
    <Dialog
      description={t('pairedAgents.dialogDescription')}
      dismissDisabled={decide.isPending}
      onClose={close}
      open={open}
      size="lg"
      title={t('pairedAgents.pair')}
    >
      <div className="grid gap-4">
        <CodeInput
          label={t('pairedAgents.code')}
          onChange={(next) => {
            setDecided(null)
            setActionError(null)
            setCode(next)
          }}
          value={code}
        />

        {!tenantReady ? (
          <p className="text-sm text-[color:var(--tx3)]">
            {t('pairedAgents.chooseContext')}
          </p>
        ) : null}

        <FormError>{actionError}</FormError>

        {decided ? (
          <FormSuccess>
            {decided === 'allowed'
              ? t('pairedAgents.allowed')
              : t('pairedAgents.refused')}
          </FormSuccess>
        ) : null}

        <FormError>
          {code.trim().length > 0 && !decided && pending.isError
            ? t('pairedAgents.invalidCode')
            : undefined}
        </FormError>

        {pending.data && !decided ? (
          <div className="grid gap-3 rounded-lg border border-[var(--bd)] p-3">
            <div className="text-sm font-medium text-[var(--tx)]">
              <span className="font-semibold">{pending.data.clientName}</span>
              {t('pairedAgents.wantsToWorkUntil', { date: formatCredentialDate(pending.data.credentialExpiresAt) })}
            </div>

            <p className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">
              {t('pairedAgents.ableTo')}
            </p>
            <div className="grid gap-2">
              {SCOPE_ORDER.filter((scope) => requested.includes(scope)).map((scope) => (
                <Checkbox
                  checked={granted.includes(scope)}
                  description={SCOPE_COPY[scope].detail}
                  key={scope}
                  label={SCOPE_COPY[scope].label}
                  onChange={(checked) =>
                    setGranted((current) =>
                      checked ? [...current, scope] : current.filter((held) => held !== scope))}
                />
              ))}
            </div>

            {/* The old copy said "Untrusted — this name is whatever the agent
                calls itself", which is exactly right and reads as jargon. The
                fact survives; the word does not. */}
            <p className="text-xs text-[color:var(--tx3)]">
              {t('pairedAgents.verifyClient')}
            </p>
          </div>
        ) : null}

        <FormActions>
          {decided ? (
            <button className="admin-button admin-button-primary" onClick={close} type="button">
              {t('pairedAgents.done')}
            </button>
          ) : (
            <>
              <button
                className="admin-button admin-button-secondary"
                disabled={decide.isPending || !pending.data}
                onClick={() => submit(false)}
                type="button"
              >
                {t('pairedAgents.dontAllow')}
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={decide.isPending || granted.length === 0 || !tenantReady}
                onClick={() => submit(true)}
                type="button"
              >
                {decide.isPending ? t('pairedAgents.pairing') : t('pairedAgents.allow')}
              </button>
            </>
          )}
        </FormActions>
      </div>
    </Dialog>
  )
}
