import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  evaluateOrganizationTheme,
  type EvaluatedTheme,
  type OrganizationTheme,
} from '@nessie/schemas'
import { Card } from '../../../components/shared/Card'
import { ColourField } from '../../../components/shared/ColourField'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { FormError, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Notice } from '../../../components/primitives/Notice'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { TabBar } from '../../../components/primitives/TabBar'
import { ThemeChecks } from './ThemeChecks'
import {
  useCurrentOrganization,
  useUpdateOrganizationTheme,
} from '../../../facades/organization/hooks'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import { useTheme } from '../../../providers/ThemeProvider'
import type { PageHeaderAction } from '../../../components/shared/ResponsivePageHeader'

/**
 * Where an organisation's colours are authored
 * (docs/plans/2026-09-05-organisation-custom-theme.md §7).
 *
 * Four seeds; the other forty-eight tokens are derived by `@nessie/schemas` so
 * the API and this screen cannot disagree about what the palette is. Colours
 * only — type, radii, spacing and motion are `:root` in `styles.css` and are
 * not authorable here or anywhere.
 */

// Daylight's values: the most neutral place to start, and valid as they stand,
// so an organisation that wants Daylight-as-ours can save without editing.
const STARTING_THEME: OrganizationTheme = {
  appearance: 'light',
  accent: '#2563eb',
  surface: '#f8fafc',
  sidebar: null,
}

export const OrganizationAppearancePage = ({ tabs }: SettingsTabHostProps) => {
  const { t } = useTranslation('settings')
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateTheme = useUpdateOrganizationTheme()
  const { setPreview } = useTheme()

  const saved = organization?.theme ?? null
  const [draft, setDraft] = useState<OrganizationTheme>(saved ?? STARTING_THEME)
  const [deriveSidebar, setDeriveSidebar] = useState((saved ?? STARTING_THEME).sidebar === null)
  const [feedback, setFeedback] = useState<{ error?: string; success?: string }>({})
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  // Seed the form from the saved palette once it arrives, keyed on the palette
  // itself so a background refetch cannot clobber an edit in progress.
  const savedKey = saved ? JSON.stringify(saved) : 'none'
  useEffect(() => {
    setDraft(saved ?? STARTING_THEME)
    setDeriveSidebar((saved ?? STARTING_THEME).sidebar === null)
    // `saved` is read at this render, never a dependency: keying on it would
    // re-seed — and so discard an edit in progress — on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  const evaluated = useMemo(() => evaluateOrganizationTheme(draft), [draft])
  const blocking = evaluated.checks.find((check) => check.level === 'blocking')
  const blockingMessage = blocking
    ? t(`organization.checks.${blocking.id}.${blocking.id === 'surface-band'
      ? draft.appearance : 'detail'}`, { ratio: blocking.ratio })
    : undefined

  // The app is the preview: a valid draft is painted onto the real shell, so
  // the sidebar, header, cards and status colours an admin is judging are the
  // ones people will actually see. An invalid draft holds the last valid one,
  // which is what keeps this page readable no matter what is typed.
  const [lastValid, setLastValid] = useState<EvaluatedTheme | null>(null)
  useEffect(() => {
    if (evaluated.valid) setLastValid(evaluated)
  }, [evaluated])
  useEffect(() => {
    setPreview(evaluated.valid ? evaluated : lastValid)
  }, [evaluated, lastValid, setPreview])
  useEffect(() => () => setPreview(null), [setPreview])

  const update = (patch: Partial<OrganizationTheme>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setFeedback({})
  }

  // Dirty against what the form started from — the saved palette, or the
  // starting one when there is none. Comparing against `savedKey` would make an
  // untouched first visit look edited and offer "Reset to saved" with nothing
  // to reset to.
  const baseline = JSON.stringify(saved ?? STARTING_THEME)
  const dirty = baseline !== JSON.stringify(draft)
  const save = async (): Promise<void> => {
    setFeedback({})
    try {
      await updateTheme.mutateAsync(draft)
      setFeedback({ success: t('organization.themeSaved', { organization: organization?.name ?? t('organization.organisation') }) })
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : t('organization.themeSaveFailed') })
    }
  }

  const remove = async (): Promise<void> => {
    setConfirmingRemove(false)
    setFeedback({})
    try {
      await updateTheme.mutateAsync(null)
      setFeedback({ success: t('organization.themeRemoved') })
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : t('organization.themeRemoveFailed') })
    }
  }

  const actions: PageHeaderAction[] = [
    {
      disabled: !evaluated.valid || updateTheme.isPending || (!dirty && saved !== null),
      id: 'save-theme',
      label: updateTheme.isPending ? t('common.saving') : t('organization.saveTheme'),
      onSelect: () => void save(),
      primary: true,
      priority: 1,
    },
    ...(saved
      ? [{
        disabled: updateTheme.isPending,
        id: 'remove-theme',
        label: t('organization.removeTheme'),
        onSelect: () => setConfirmingRemove(true),
        priority: 2,
        tone: 'danger' as const,
      }]
      : []),
  ]

  return (
    <SettingsPanel actions={actions} eyebrow={t('organization.organisation')} title={t('organization.appearance')}>
      {tabs}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section">
          <SectionLabel>{t('appearance.theme.title')}</SectionLabel>
          {isLoading ? (
            <div className="mt-2 text-sm text-[color:var(--tx2)]">{t('common.loading')}</div>
          ) : (
            <>
              <div className="mt-2 text-sm text-[color:var(--tx2)]">
                {t('organization.themeDescription', { organization: organization?.name ?? t('organization.organisation') })}
              </div>

              {saved ? null : (
                <Notice className="mt-4" tone="neutral">
                  {t('organization.noTheme')}
                </Notice>
              )}

              <div className="mt-4 grid gap-4">
                <FormField
                  help={t('organization.appearanceHelp')}
                  label={t('organization.appearance')}
                >
                  {/* One field of an unsaved draft, so its value is component
                      state rather than a URL param: this page is already
                      `?tab=appearance`, and a second `tab` would collide with
                      the one the organisation screen owns. Allowlisted in
                      admin/test/tab-param.test.ts. */}
                  <div className="flex">
                    <TabBar
                      ariaLabel={t('organization.appearance')}
                      collapse="never"
                      items={[
                        { label: t('organization.light'), value: 'light' as const },
                        { label: t('organization.dark'), value: 'dark' as const },
                      ]}
                      onChange={(appearance) => update({ appearance })}
                      role="radiogroup"
                      value={draft.appearance}
                    />
                  </div>
                </FormField>

                <FormField
                  help={t('organization.accentHelp')}
                  label={t('organization.accent')}
                >
                  <ColourField
                    label={t('organization.accent')}
                    onChange={(accent) => update({ accent })}
                    value={draft.accent}
                  />
                </FormField>

                <FormField
                  help={t('organization.backgroundHelp')}
                  label={t('organization.background')}
                >
                  <ColourField
                    label={t('organization.background')}
                    onChange={(surface) => update({ surface })}
                    value={draft.surface}
                  />
                </FormField>

                <FormField
                  help={t('organization.sidebarHelp')}
                  label={t('organization.sidebar')}
                >
                  <div className="grid gap-2">
                    <label className="flex items-center gap-2 text-sm text-[color:var(--tx2)]">
                      <input
                        checked={deriveSidebar}
                        onChange={(event) => {
                          setDeriveSidebar(event.target.checked)
                          update({
                            sidebar: event.target.checked ? null : evaluated.tokens.sb,
                          })
                        }}
                        type="checkbox"
                      />
                      {t('organization.deriveSidebar')}
                    </label>
                    <ColourField
                      disabled={deriveSidebar}
                      label={t('organization.sidebar')}
                      onChange={(sidebar) => update({ sidebar })}
                      value={draft.sidebar ?? evaluated.tokens.sb}
                    />
                  </div>
                </FormField>
              </div>

              <div className="mt-4 grid gap-2">
                <FormError>{feedback.error ?? blockingMessage}</FormError>
                <FormSuccess>{feedback.success}</FormSuccess>
                {dirty ? (
                  <button
                    className="justify-self-end text-sm text-[color:var(--lnk)] hover:underline"
                    onClick={() => {
                      setDraft(saved ?? STARTING_THEME)
                      setDeriveSidebar((saved ?? STARTING_THEME).sidebar === null)
                      setFeedback({})
                    }}
                    type="button"
                  >
                    {t('organization.resetToSaved')}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </Card>

        <section className="grid gap-4 content-start">
          <Notice tone="info">
            {t('organization.previewNotice', { organization: organization?.name ?? t('organization.organisation') })}
          </Notice>
          <ThemeChecks evaluated={evaluated} />
        </section>
      </div>

      <ConfirmDialog
        body={t('organization.removeThemeConfirmation', { organization: organization?.name ?? t('organization.organisation') })}
        confirmLabel={t('organization.removeTheme')}
        destructive
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void remove()}
        open={confirmingRemove}
        pending={updateTheme.isPending}
        title={t('organization.removeThemeTitle')}
      />
    </SettingsPanel>
  )
}
