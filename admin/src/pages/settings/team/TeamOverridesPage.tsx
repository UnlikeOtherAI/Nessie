import type { ReactNode } from 'react'
import { resolveBrowserHomepage } from '@nessie/schemas'

import { localInferenceEnablementState } from '../../../components/features/local-inference/local-inference-enablement-state'
import {
  teamInheritanceChips,
  type InheritanceChip,
} from '../../../components/features/settings/setting-inheritance'
import { Pill } from '../../../components/primitives/Pill'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Row, RowList } from '../../../components/shared/RowList'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import { useIsOrganizationAdmin, useIsOwner } from '../../../facades/auth/hooks'
import { useMailboxConnections } from '../../../facades/mailbox-connections/hooks'
import { useOrganizationAdministration } from '../../../facades/organization/hooks'
import { useSecrets } from '../../../facades/secrets/hooks'
import {
  SETTING_KEYS,
  settingFor,
  useScopedSettings,
  type SettingScope,
} from '../../../facades/settings/hooks'
import type { TeamRecord } from '../../../lib/api-client'
import {
  connectionScopeOptions,
  keyScopeOptions,
  modelScopeOptions,
  ownComputersDoorway,
  teamDoorway,
  type ScopeDoorway,
  type ScopeViewer,
} from '../../admin/scope-entitlements'

const BROWSER_KEYS = [SETTING_KEYS.browserConnection, SETTING_KEYS.browserHomepage]
const POLICY_KEYS = [SETTING_KEYS.localInferenceEnabled]

/**
 * One setting as it stands for this team. The value and the chips sit under
 * the name rather than beside it, so on a phone they wrap instead of cutting
 * the sentence short or squeezing the name to a few letters. A doorway the
 * viewer may not use is present, greyed and inert, and its value says who can.
 */
const Setting = ({ chips = [], target, title, value }: {
  chips?: readonly InheritanceChip[]
  target: ScopeDoorway
  title: string
  value: string
}) => (
  <Row
    {...('href' in target ? { href: target.href } : { className: 'opacity-60', disabled: true })}
    title={title}
  >
    <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">{value}</span>
    {chips.length > 0 ? (
      <span className="mt-1.5 flex flex-wrap gap-1">
        {chips.map((chip) => (
          <Pill key={chip.label} radius="chip" size="sm" tone={chip.tone} uppercase={false}>
            {chip.label}
          </Pill>
        ))}
      </span>
    ) : null}
  </Row>
)

const Group = ({ children, title }: { children: ReactNode; title: string }) => (
  <section aria-label={title} className="grid gap-2">
    <SectionLabel as="h2">{title}</SectionLabel>
    <RowList label={title}>{children}</RowList>
  </section>
)

const count = (value: number, one: string, many: string): string =>
  `${value === 0 ? 'No' : value} ${value === 1 ? one : many}`

/** A value is stated only once its read has answered; a default is not a fact yet. */
const once = (query: { isError: boolean; isLoading: boolean }, sentence: () => string): string =>
  query.isLoading ? 'Loading…' : query.isError ? 'This could not be loaded.' : sentence()

const browserAccountSentence = (lockedAt: SettingScope | null): string =>
  lockedAt === 'organization'
    ? 'Everyone uses the organisation’s account; this team cannot connect its own.'
    : lockedAt === 'team'
      ? 'Its people use this team’s account or the organisation’s, never their own.'
      : 'This team’s own account when one is connected, otherwise the organisation’s.'

/**
 * What this team sets over the organisation, read, not edited: each value in
 * force here, where it comes from and who locked it, and a row that opens the
 * page owning the setting with this team already chosen. The team page never
 * re-implements a setting (docs/plans/2026-09-26-admin-ux-overhaul.md §6.8).
 */
export const TeamOverridesPage = ({ host, team }: { host?: SettingsTabHostProps; team: TeamRecord }) => {
  const viewer: ScopeViewer = { isOrganizationAdmin: useIsOrganizationAdmin(), isOwner: useIsOwner() }
  const models = teamDoorway(modelScopeOptions(viewer, [team]), '/admin/models', team.id)
  const connections = teamDoorway(connectionScopeOptions(viewer, [team]), '/admin/connections', team.id)
  const keys = teamDoorway(keyScopeOptions(viewer, [team]), '/admin/keys', team.id)
  // The own-computers policy is an administrator-authored key: its row is read,
  // and opens AI models, only with the organisation-administration standing.
  const ownComputers = ownComputersDoorway(models, useOrganizationAdministration())
  const policyReadable = 'href' in ownComputers
  const browser = useScopedSettings('team', BROWSER_KEYS, team.id)
  const policy = useScopedSettings('team', policyReadable ? POLICY_KEYS : [], team.id)
  const mailboxes = useMailboxConnections()
  const secrets = useSecrets(viewer.isOwner)

  const policySetting = settingFor(policy.data, SETTING_KEYS.localInferenceEnabled)
  const connectionSetting = settingFor(browser.data, SETTING_KEYS.browserConnection)
  const homepageSetting = settingFor(browser.data, SETTING_KEYS.browserHomepage)
  const teamMailboxes = (mailboxes.data?.connections ?? [])
    .filter((row) => row.scope === 'team' && row.teamId === team.id)
  const ownKeys = (secrets.data ?? []).filter((secret) =>
    secret.scopeType === 'team' && secret.scopeId === team.id && secret.status === 'active')
  const lockedAbove = (secrets.data ?? []).filter((secret) =>
    secret.scopeType === 'organization' && secret.locked && secret.status === 'active')

  return (
    <SettingsPanel
      eyebrow="Teams"
      host={host}
      subtitle="What this team sets over the organisation’s defaults. Each row opens the page where it is changed, with this team chosen."
      title="Overrides"
    >
      <div className="grid gap-6">
        <Group title="AI models">
          <Setting
            target={models}
            title="Models this team may use"
            value="A team can only switch off models the organisation offers."
          />
          <Setting
            chips={policyReadable ? teamInheritanceChips(policySetting) : []}
            target={ownComputers}
            title="AI on people’s own computers"
            value={'reason' in ownComputers
              ? ownComputers.reason
              : once(policy, () => localInferenceEnablementState(policySetting).enabled
                ? 'Its people may use AI models on their own computers.'
                : 'Its people may not use AI models on their own computers.')}
          />
        </Group>

        <Group title="Company connections">
          <Setting
            target={connections}
            title="Shared mailboxes"
            value={once(mailboxes, () =>
              `${count(teamMailboxes.length, 'shared mailbox', 'shared mailboxes')} connected.`)}
          />
          <Setting
            chips={teamInheritanceChips(connectionSetting)}
            target={connections}
            title="Cloud browser account"
            value={once(browser, () => browserAccountSentence(connectionSetting?.lockedAtScope ?? null))}
          />
          <Setting
            chips={teamInheritanceChips(homepageSetting)}
            target={connections}
            title="Browser home page"
            value={once(browser, () =>
              `Agents’ browsers open at ${resolveBrowserHomepage(homepageSetting?.value ?? null)}${
                homepageSetting?.setAtScope ? '.' : ', the built-in default.'}`)}
          />
        </Group>

        <Group title="Keys">
          <Setting
            chips={'reason' in keys || lockedAbove.length === 0
              ? []
              : [{ label: `${lockedAbove.length} locked by organisation`, tone: 'warning' }]}
            target={keys}
            title="Keys"
            value={'reason' in keys
              ? keys.reason
              : once(secrets, () => `${count(ownKeys.length, 'key', 'keys')} of its own.`)}
          />
        </Group>
      </div>
    </SettingsPanel>
  )
}
