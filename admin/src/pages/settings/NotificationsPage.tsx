import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUpdatePreferences } from '../../facades/auth/hooks'
import { useChannels, useSetChannelMute } from '../../facades/channels/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useFocusMode } from '../../providers/FocusModeProvider'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { NotificationPreferencesForm } from './notifications/NotificationPreferencesForm'
import { FeedbackBanner, type SettingsFeedback } from './FeedbackBanner'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { Switch } from '../../components/primitives/Switch'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { QueryState } from '../../components/shared/QueryState'
import { Row, RowList } from '../../components/shared/RowList'

const getBrowserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const NotificationsPage = ({ tabs }: SettingsTabHostProps) => {
  const { t } = useTranslation('settings')
  const { me } = useAuthSession()
  const { focusModeEnabled, setFocusModeEnabled, updating: focusModeUpdating } = useFocusMode()
  const channelsQuery = useChannels()
  const channels = channelsQuery.data ?? []
  const browserTimeZone = useMemo(() => getBrowserTimeZone(), [])
  const updatePreferences = useUpdatePreferences()
  const setChannelMute = useSetChannelMute()

  const [channelFeedback, setChannelFeedback] = useState<SettingsFeedback | null>(null)
  const [channelMuteOverrides, setChannelMuteOverrides] = useState<Record<string, boolean>>({})

  if (!me) {
    return null
  }

  const saveChannelMute = async (
    channelId: string,
    previousMuted: boolean,
    nextMuted: boolean,
  ) => {
    setChannelFeedback(null)
    setChannelMuteOverrides((current) => ({ ...current, [channelId]: nextMuted }))

    try {
      const result = await setChannelMute.mutateAsync({ channelId, muted: nextMuted })
      setChannelMuteOverrides((current) => ({ ...current, [channelId]: result.muted }))
      setChannelFeedback({ kind: 'success', message: t('notifications.channelSaved') })
    } catch (error) {
      setChannelMuteOverrides((current) => ({ ...current, [channelId]: previousMuted }))
      setChannelFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : t('notifications.channelSaveFailed'),
      })
    }
  }

  return (
    <SettingsPanel
      eyebrow={t('common.user')}
      title={t('notifications.title')}
      actions={[
        {
          disabled: updatePreferences.isPending,
          form: 'notification-preferences-form',
          id: 'save-preferences',
          label: updatePreferences.isPending ? t('common.saving') : t('notifications.savePreferences'),
          onSelect: () => undefined,
          primary: true,
          priority: 100,
          submit: true,
        } satisfies PageHeaderAction,
      ]}
    >
      {tabs}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        {/* Focus Mode reads its own provider (not `me.user.preferences`) and
            stays mounted across a user switch, so it lives outside the
            preferences form's `key={me.user.id}` remount boundary below. */}
        <div className="grid gap-4">
          <section className="admin-card p-4">
            <SectionLabel>{t('notifications.focusMode')}</SectionLabel>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="font-semibold text-[color:var(--tx)]">{t('notifications.pauseDistractions')}</div>
                <div className="mt-1 text-sm text-[color:var(--tx2)]">
                  {focusModeEnabled
                    ? t('notifications.focusEnabledDescription')
                    : t('notifications.focusDisabledDescription')}
                </div>
              </div>
              <Switch
                checked={focusModeEnabled}
                disabled={focusModeUpdating}
                label={t('notifications.toggleFocus')}
                onChange={setFocusModeEnabled}
              />
            </div>
          </section>

          <NotificationPreferencesForm
            browserTimeZone={browserTimeZone}
            key={me.user.id}
            preferences={me.user.preferences ?? {}}
            updatePreferences={updatePreferences}
          />
        </div>

        <Card variant="section">
          <SectionLabel>{t('notifications.mutedChannels')}</SectionLabel>
          <div className="mt-4">
            <QueryState
              className="py-4"
              errorLabel={t('notifications.channelsLoadFailed')}
              loadingLabel={t('notifications.channelsLoading')}
              query={channelsQuery}
            >
              {() =>
                channels.length === 0 ? (
                  <EmptyState>{t('notifications.noChannels')}</EmptyState>
                ) : (
                  <RowList label={t('notifications.mutedChannels')}>
                    {channels.map((channel) => {
                      const muted = channelMuteOverrides[channel.id] ?? channel.muted ?? false
                      const pending =
                        setChannelMute.isPending
                        && setChannelMute.variables?.channelId === channel.id

                      return (
                        <Row
                          key={channel.id}
                          subtitle={muted ? t('notifications.muted') : channel.visibility}
                          title={`#${channel.label}`}
                          trailing={
                            <>
                              <Switch
                                checked={muted}
                                disabled={pending}
                                label={t('notifications.toggleChannel', { channel: channel.label })}
                                onChange={(nextMuted) =>
                                  void saveChannelMute(channel.id, muted, nextMuted)}
                              />
                              {pending ? (
                                <span className="sr-only" role="status">
                                  {t('notifications.savingChannel')}
                                </span>
                              ) : null}
                            </>
                          }
                        />
                      )
                    })}
                  </RowList>
                )
              }
            </QueryState>
          </div>
          <div className="mt-3">
            <FeedbackBanner feedback={channelFeedback} />
          </div>
        </Card>
      </div>
    </SettingsPanel>
  )
}
