import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { budgetKeys } from '../../../lib/query-keys'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useProjects, useTeams } from '../../../facades/projects/hooks'
import { Pill, type PillTone } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'

type BudgetMode = 'off' | 'warn' | 'enforce' | 'degrade' | 'unlimited'
type BudgetScopeType = 'organization' | 'project' | 'team'
type BudgetPeriod = 'weekly' | 'monthly' | 'yearly'

type BudgetStatus = {
  scopeType: BudgetScopeType
  scopeId: string
  mode: BudgetMode
  period: BudgetPeriod
  costLimitUsd: number | null
  tokenLimit: number | null
  spentUsd: number
  spentTokens: number
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  degradeModel: string | null
  degradeProvider: string | null
  level: 'ok' | 'warn' | 'over'
  percentUsed: number | null
  costTrackingActive: boolean
  storageLimitBytes: string | null
  storageUsedBytes: string
}

const BYTES_PER_GB = 1024 ** 3

const formatBytes = (bytes: number, locale: string): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 || exponent === 0 ? 0 : 1 }).format(value)} ${units[exponent]}`
}

const formatTokens = (count: number, locale: string) => new Intl.NumberFormat(locale).format(count)
const formatUsd = (amount: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount)

const parseLimit = (raw: string, integer: boolean): number | null | 'invalid' => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return integer ? Math.round(value) : value
}

const levelTone: Record<BudgetStatus['level'], PillTone> = {
  ok: 'success',
  warn: 'warning',
  over: 'danger',
}

export const BudgetManager = ({ organizationId }: { organizationId: string }) => {
  const { t, i18n } = useTranslation('opsBudget')
  const locale = i18n.resolvedLanguage ?? 'en-GB'
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const budgetsQuery = useQuery<BudgetStatus[]>({
    queryKey: budgetKeys.all,
    queryFn: () => apiClient.get('/api/ledger/budgets'),
  })
  const budgets = budgetsQuery.data ?? []
  const { data: projects = [] } = useProjects()
  const { data: teams = [] } = useTeams()
  const [pendingDelete, setPendingDelete] = useState<BudgetStatus | null>(null)

  const [scopeType, setScopeType] = useState<BudgetScopeType>('organization')
  const [scopeId, setScopeId] = useState('')
  const [mode, setMode] = useState<BudgetMode>('warn')
  const [period, setPeriod] = useState<BudgetPeriod>('monthly')
  const [costLimit, setCostLimit] = useState('')
  const [tokenLimit, setTokenLimit] = useState('')
  const [warnThreshold, setWarnThreshold] = useState('80')
  const [blockHumans, setBlockHumans] = useState(false)
  const [degradeModel, setDegradeModel] = useState('')
  const [degradeProvider, setDegradeProvider] = useState('openai')
  const [storageCapGb, setStorageCapGb] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const resetForm = () => {
    setScopeType('organization')
    setScopeId('')
    setMode('warn')
    setPeriod('monthly')
    setCostLimit('')
    setTokenLimit('')
    setWarnThreshold('80')
    setBlockHumans(false)
    setDegradeModel('')
    setDegradeProvider('openai')
    setStorageCapGb('')
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: budgetKeys.all })
  }

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => apiClient.put('/api/ledger/budget', payload),
    onSuccess: () => {
      setFormError(null)
      resetForm()
      invalidate()
    },
    onError: () => setFormError(t('saveFailed')),
  })

  const remove = useMutation({
    mutationFn: (target: { scopeType: BudgetScopeType; scopeId: string }) =>
      apiClient.delete(`/api/ledger/budget?scopeType=${target.scopeType}&scopeId=${target.scopeId}`),
    onSuccess: () => {
      setPendingDelete(null)
      invalidate()
    },
  })

  const handleSave = () => {
    const resolvedScopeId = scopeType === 'organization' ? organizationId : scopeId
    if (scopeType !== 'organization' && !scopeId) {
      setFormError(t('chooseScope'))
      return
    }
    const cost = parseLimit(costLimit, false)
    const tokens = parseLimit(tokenLimit, true)
    if (cost === 'invalid' || tokens === 'invalid') {
      setFormError(t('invalidCap'))
      return
    }
    const threshold = Math.round(Number(warnThreshold))
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      setFormError(t('invalidThreshold'))
      return
    }
    if (mode === 'degrade' && degradeModel.trim() === '') {
      setFormError(t('fallbackModelRequired'))
      return
    }
    const storageGb = parseLimit(storageCapGb, false)
    if (storageGb === 'invalid') {
      setFormError(t('invalidStorageCap'))
      return
    }
    setFormError(null)
    save.mutate({
      scopeType,
      scopeId: resolvedScopeId,
      costLimitUsd: cost,
      tokenLimit: tokens,
      storageLimitBytes: storageGb === null ? null : Math.round(storageGb * BYTES_PER_GB),
      mode,
      period,
      warnThresholdPercent: threshold,
      blockHumansWhenOver: blockHumans,
      degradeModel: mode === 'degrade' ? degradeModel.trim() : null,
      degradeProvider: mode === 'degrade' ? degradeProvider.trim() || 'openai' : null,
    })
  }

  const editBudget = (b: BudgetStatus) => {
    setScopeType(b.scopeType)
    setScopeId(b.scopeType === 'organization' ? '' : b.scopeId)
    setMode(b.mode)
    setPeriod(b.period)
    setCostLimit(b.costLimitUsd != null ? String(b.costLimitUsd) : '')
    setTokenLimit(b.tokenLimit != null ? String(b.tokenLimit) : '')
    setWarnThreshold(String(b.warnThresholdPercent))
    setBlockHumans(b.blockHumansWhenOver)
    setDegradeModel(b.degradeModel ?? '')
    setDegradeProvider(b.degradeProvider ?? 'openai')
    setStorageCapGb(
      b.storageLimitBytes ? String(Number(b.storageLimitBytes) / BYTES_PER_GB) : '',
    )
  }

  const scopeLabel = (b: BudgetStatus): string => {
    if (b.scopeType === 'organization') return t('organization')
    if (b.scopeType === 'project') return projects.find((p) => p.id === b.scopeId)?.name ?? t('project')
    return teams.find((team) => team.id === b.scopeId)?.name ?? t('team')
  }

  const scopeNames: Record<BudgetScopeType, string> = {
    organization: t('organization'), project: t('project'), team: t('team'),
  }
  const modeNames: Record<BudgetMode, string> = {
    off: t('modeOffShort'), warn: t('modeWarnShort'), enforce: t('modeEnforceShort'),
    degrade: t('modeDegradeShort'), unlimited: t('modeUnlimitedShort'),
  }
  const periodNames: Record<BudgetPeriod, string> = {
    weekly: t('weekly'), monthly: t('monthly'), yearly: t('yearly'),
  }
  const periodUsage: Record<BudgetPeriod, string> = {
    weekly: t('thisWeek'), monthly: t('thisMonth'), yearly: t('thisYear'),
  }

  return (
    <div className="admin-card mt-4 p-4">
      <SectionLabel>{t('title')}</SectionLabel>
      <p className="mt-1 text-xs text-[color:var(--tx2)]">
        {t('description')}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          {t('scope')}
          <select
            className="admin-input mt-1"
            onChange={(e) => {
              setScopeType(e.target.value as BudgetScopeType)
              setScopeId('')
            }}
            value={scopeType}
          >
            <option value="organization">{t('organization')}</option>
            <option value="project">{t('project')}</option>
            <option value="team">{t('team')}</option>
          </select>
        </label>
        {scopeType !== 'organization' && (
          <label className="text-xs text-[color:var(--tx2)]">
            {scopeType === 'project' ? t('project') : t('team')}
            <select
              className="admin-input mt-1"
              onChange={(e) => setScopeId(e.target.value)}
              value={scopeId}
            >
              <option value="">{t('select')}</option>
              {(scopeType === 'project' ? projects : teams).map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          {t('mode')}
          <select
            className="admin-input mt-1"
            onChange={(e) => setMode(e.target.value as BudgetMode)}
            value={mode}
          >
            <option value="off">{t('modeOff')}</option>
            <option value="warn">{t('modeWarn')}</option>
            <option value="enforce">{t('modeEnforce')}</option>
            <option value="degrade">{t('modeDegrade')}</option>
            <option value="unlimited">{t('modeUnlimited')}</option>
          </select>
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          {t('period')}
          <select
            className="admin-input mt-1"
            onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
            value={period}
          >
            <option value="weekly">{t('weekly')}</option>
            <option value="monthly">{t('monthly')}</option>
            <option value="yearly">{t('yearly')}</option>
          </select>
        </label>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          {t('storageCap')}
          <input
            className="admin-input mt-1"
            inputMode="decimal"
            onChange={(e) => setStorageCapGb(e.target.value)}
            placeholder={t('noCap')}
            value={storageCapGb}
          />
          <span className="mt-1 block text-[11px] text-[color:var(--tx3)]">
            {t('storageCapHelp')}
          </span>
        </label>
      </div>

      {(mode === 'warn' || mode === 'enforce' || mode === 'degrade') && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-[color:var(--tx2)]">
            {t('costCap')}
            <input
              className="admin-input mt-1"
              inputMode="decimal"
              onChange={(e) => setCostLimit(e.target.value)}
              placeholder={t('noCap')}
              value={costLimit}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            {t('tokenCap')}
            <input
              className="admin-input mt-1"
              inputMode="numeric"
              onChange={(e) => setTokenLimit(e.target.value)}
              placeholder={t('noCap')}
              value={tokenLimit}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            {t('warnAt')}
            <input
              className="admin-input mt-1"
              inputMode="numeric"
              onChange={(e) => setWarnThreshold(e.target.value)}
              placeholder="80"
              value={warnThreshold}
            />
          </label>
        </div>
      )}

      {mode === 'enforce' && (
        <label className="mt-3 flex items-center gap-2 text-sm text-[color:var(--tx2)]">
          <input
            checked={blockHumans}
            onChange={(e) => setBlockHumans(e.target.checked)}
            type="checkbox"
          />
          {t('blockLiveRequests')}
        </label>
      )}

      {mode === 'degrade' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[color:var(--tx2)]">
            {t('fallbackModel')}
            <input
              className="admin-input mt-1"
              onChange={(e) => setDegradeModel(e.target.value)}
              placeholder={t('modelExample')}
              value={degradeModel}
            />
          </label>
          <label className="text-xs text-[color:var(--tx2)]">
            {t('fallbackProvider')}
            <input
              className="admin-input mt-1"
              onChange={(e) => setDegradeProvider(e.target.value)}
              placeholder="openai"
              value={degradeProvider}
            />
          </label>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="admin-button admin-button-secondary" onClick={resetForm} type="button">
          {t('clear')}
        </button>
        <button
          className="admin-button admin-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
          type="button"
        >
          {t('saveBudget')}
        </button>
      </div>
      {formError && <div className="mt-2 text-xs text-[var(--danger-text)]">{formError}</div>}

      <SectionLabel className="mt-5">{t('configuredBudgets', { count: budgets.length })}</SectionLabel>
      <div className="mt-2 grid gap-2">
        <QueryState
          emptyLabel={t('noBudgets')}
          errorLabel={t('loadFailed')}
          isEmpty={budgets.length === 0}
          loadingLabel={t('loading')}
          query={budgetsQuery}
        >
          {() => (
            <>
              {budgets.map((b) => (
                <div key={`${b.scopeType}:${b.scopeId}`} className="admin-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-[var(--tx)]">{scopeLabel(b)}</span>
                      <span className="ml-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                        {scopeNames[b.scopeType]} · {modeNames[b.mode]} · {periodNames[b.period]}
                      </span>
                    </div>
                    <Pill
                      className="shrink-0"
                      size="sm"
                      tone={b.mode === 'unlimited' ? 'muted' : levelTone[b.level]}
                    >
                      {b.mode === 'unlimited'
                        ? t('modeUnlimitedShort')
                        : b.percentUsed != null
                          ? t('percentUsed', { percent: b.percentUsed })
                          : t('noCapLower')}
                    </Pill>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {t('spentSummary', { tokens: formatTokens(b.spentTokens, locale),
                      amount: formatUsd(b.spentUsd, locale), period: periodUsage[b.period] })}
                    {b.costLimitUsd != null && t('costCapSummary', { amount: formatUsd(b.costLimitUsd, locale) })}
                    {b.tokenLimit != null && t('tokenCapSummary', { tokens: formatTokens(b.tokenLimit, locale) })}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--tx2)]">
                    {t('stored', { amount: formatBytes(Number(b.storageUsedBytes), locale) })}
                    {b.storageLimitBytes != null
                      ? t('ofStorageCap', { amount: formatBytes(Number(b.storageLimitBytes), locale) })
                      : t('noStorageCap')}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="admin-button admin-button-secondary"
                      onClick={() => editBudget(b)}
                      type="button"
                    >
                      {t('edit')}
                    </button>
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={remove.isPending}
                      onClick={() => setPendingDelete(b)}
                      type="button"
                    >
                      {t('delete')}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </QueryState>
      </div>

      <ConfirmDialog
        body={pendingDelete ? t('deleteBody', { scope: scopeLabel(pendingDelete) }) : undefined}
        confirmLabel={t('deleteBudget')}
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            remove.mutate({ scopeType: pendingDelete.scopeType, scopeId: pendingDelete.scopeId })
          }
        }}
        open={pendingDelete != null}
        pending={remove.isPending}
        title={t('deleteTitle')}
      />
    </div>
  )
}
