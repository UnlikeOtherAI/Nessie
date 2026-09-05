import { useEffect, useMemo, useState } from 'react'
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

const APPEARANCES = [
  { label: 'Light', value: 'light' as const },
  { label: 'Dark', value: 'dark' as const },
]

export const OrganizationAppearancePage = ({ tabs }: SettingsTabHostProps) => {
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
  }, [savedKey])

  const evaluated = useMemo(() => evaluateOrganizationTheme(draft), [draft])
  const blocking = evaluated.checks.find((check) => check.level === 'blocking')

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
      setFeedback({ success: `Theme saved. It's now the default for everyone in `
        + `${organization?.name ?? 'your organisation'} who hasn't chosen one.` })
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : 'Could not save the theme.' })
    }
  }

  const remove = async (): Promise<void> => {
    setConfirmingRemove(false)
    setFeedback({})
    try {
      await updateTheme.mutateAsync(null)
      setFeedback({ success: 'Theme removed.' })
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : 'Could not remove the theme.' })
    }
  }

  const actions: PageHeaderAction[] = [
    {
      disabled: !evaluated.valid || updateTheme.isPending || (!dirty && saved !== null),
      id: 'save-theme',
      label: updateTheme.isPending ? 'Saving…' : 'Save theme',
      onSelect: () => void save(),
      primary: true,
      priority: 1,
    },
    ...(saved
      ? [{
        disabled: updateTheme.isPending,
        id: 'remove-theme',
        label: 'Remove theme',
        onSelect: () => setConfirmingRemove(true),
        priority: 2,
        tone: 'danger' as const,
      }]
      : []),
  ]

  return (
    <SettingsPanel actions={actions} eyebrow="Organization" title="Appearance">
      {tabs}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section">
          <SectionLabel>Theme</SectionLabel>
          {isLoading ? (
            <div className="mt-2 text-sm text-[color:var(--tx2)]">Loading…</div>
          ) : (
            <>
              <div className="mt-2 text-sm text-[color:var(--tx2)]">
                Your organisation&rsquo;s own colours, offered to everyone in{' '}
                {organization?.name ?? 'your organisation'} as a theme and used by default for
                anyone who hasn&rsquo;t chosen one. People can still pick any theme, including
                High Contrast.
              </div>

              {saved ? null : (
                <Notice className="mt-4" tone="neutral">
                  No theme yet. Start from the colours below and replace the accent with your
                  brand colour.
                </Notice>
              )}

              <div className="mt-4 grid gap-4">
                <FormField
                  help="Whether text is dark on light, or light on dark. The background and
                    sidebar must match this."
                  label="Appearance"
                >
                  {/* One field of an unsaved draft, so its value is component
                      state rather than a URL param: this page is already
                      `?tab=appearance`, and a second `tab` would collide with
                      the one the organisation screen owns. Allowlisted in
                      admin/test/tab-param.test.ts. */}
                  <div className="flex">
                    <TabBar
                      ariaLabel="Appearance"
                      collapse="never"
                      items={APPEARANCES}
                      onChange={(appearance) => update({ appearance })}
                      role="radiogroup"
                      value={draft.appearance}
                    />
                  </div>
                </FormField>

                <FormField
                  help="Buttons, links, selection and the active item. Your brand's primary colour."
                  label="Accent"
                >
                  <ColourField
                    label="Accent"
                    onChange={(accent) => update({ accent })}
                    value={draft.accent}
                  />
                </FormField>

                <FormField
                  help="The colour pages sit on. Keep it near-white for a light theme or
                    near-black for a dark one — strong colour here makes text hard to read."
                  label="Background"
                >
                  <ColourField
                    label="Background"
                    onChange={(surface) => update({ surface })}
                    value={draft.surface}
                  />
                </FormField>

                <FormField
                  help="The navigation column. Derived from your accent unless you set it."
                  label="Sidebar"
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
                      Derive from the accent
                    </label>
                    <ColourField
                      disabled={deriveSidebar}
                      label="Sidebar"
                      onChange={(sidebar) => update({ sidebar })}
                      value={draft.sidebar ?? evaluated.tokens.sb}
                    />
                  </div>
                </FormField>
              </div>

              <div className="mt-4 grid gap-2">
                <FormError>{feedback.error ?? blocking?.message}</FormError>
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
                    Reset to saved
                  </button>
                ) : null}
              </div>
            </>
          )}
        </Card>

        <section className="grid gap-4 content-start">
          <Notice tone="info">
            You&rsquo;re seeing the draft. Your own theme comes back when you leave this page —
            choose {organization?.name ?? 'your organisation'} under Account &rarr; Appearance to
            keep it.
          </Notice>
          <ThemeChecks evaluated={evaluated} />
        </section>
      </div>

      <ConfirmDialog
        body={`Everyone who hasn't chosen a theme goes back to Sandstone. People who chose `
          + `${organization?.name ?? 'your organisation'} will see Sandstone until a theme is `
          + 'saved again.'}
        confirmLabel="Remove theme"
        destructive
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void remove()}
        open={confirmingRemove}
        pending={updateTheme.isPending}
        title="Remove the organisation theme?"
      />
    </SettingsPanel>
  )
}
