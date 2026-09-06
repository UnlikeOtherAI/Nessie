import { useEffect, useState, type FormEvent } from 'react'

import {
  SETTING_KEYS,
  useWriteScopedSetting,
  type ResolvedSetting,
  type SettingScope,
} from '../../../facades/settings/hooks'
import { FormError, FormSuccess } from '../../shared/FormActions'
import { Input } from '../../shared/FormControls'
import { FormField } from '../../shared/FormField'
import { ScopedSettingGate, ScopedSettingLock } from '../settings/ScopedSettingGate'
import { browserHomepageFieldState, decideBrowserHomepageSave } from './browser-homepage-state'

type BrowserHomepageFieldProps = {
  scope: SettingScope
  /** The `browser.homepage` row from the panel's one settings query. */
  setting: ResolvedSetting | undefined
  /** Required at team scope: which team's cascade this level sits in. */
  teamId?: string | null
}

/**
 * Where an agent's browser lands, at whichever level of the cascade the panel
 * is showing.
 *
 * The field is a level of `browser.homepage`, not a property of the connected
 * account: an organisation that pins a start page has done so for the teams and
 * people below it whether or not they browse through the company's Browserbase
 * key. So the lock, the greying and the sentence naming the deciding level are
 * `ScopedSettingGate`'s, exactly as they are for the connection above it —
 * a second read-only treatment beside that one is the drift the gate exists to
 * stop.
 */
export const BrowserHomepageField = ({
  scope,
  setting,
  teamId = null,
}: BrowserHomepageFieldProps) => {
  const write = useWriteScopedSetting()
  const state = browserHomepageFieldState(setting, scope)
  const [draft, setDraft] = useState(state.ownValue)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The stored address arrives after the first paint, and again after every
  // write invalidates the query — including a write made at another level,
  // which can change what this one inherits. Seeding the box only from the
  // initial state would leave it showing an address the server no longer holds.
  useEffect(() => {
    setDraft(state.ownValue)
  }, [state.ownValue])

  /**
   * One write for both controls. A write replaces the level's whole row, so
   * each control has to resend the half it is not changing: the address write
   * carries the lock this level holds, and the lock toggle carries the address
   * the *server* has rather than whatever is in the box, so flipping the
   * checkbox can never commit an edit nobody pressed Save on.
   */
  const commit = (value: string | null, locked: boolean, saved: string) => {
    setFailure(null)
    setNotice(null)
    write.mutate(
      { key: SETTING_KEYS.browserHomepage, locked, scope, teamId, value },
      {
        onError: (cause: unknown) =>
          setFailure(cause instanceof Error ? cause.message : 'Could not save that.'),
        onSuccess: () => setNotice(saved),
      },
    )
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    setInvalid(null)
    const decision = decideBrowserHomepageSave(draft)
    if (decision.kind === 'refused') {
      setInvalid(decision.message)
      setFailure(null)
      setNotice(null)
      return
    }
    if (decision.kind === 'clear') {
      commit(null, state.lockedHere, 'Home page cleared.')
      return
    }
    setDraft(decision.value)
    commit(decision.value, state.lockedHere, 'Home page saved.')
  }

  const clear = () => {
    setInvalid(null)
    setDraft('')
    commit(null, state.lockedHere, 'Home page cleared.')
  }

  const unchanged = draft.trim() === state.ownValue

  return (
    <div className="mt-4 border-t border-[color:var(--sep)] pt-3">
      <ScopedSettingGate setting={setting}>
        <form className="grid gap-3" onSubmit={save}>
          <FormField
            error={invalid ?? undefined}
            help={
              'Where a browser opened with this account lands before an agent navigates '
              + 'anywhere. Leave it empty to follow the greyed-out address instead — the '
              + 'level above, or Nessie’s default when nobody has chosen one.'
            }
            label="Home page"
          >
            <Input
              autoComplete="off"
              // Deliberately not `type="url"`: the browser's own bubble would
              // pre-empt the schema's message, which is the one the server
              // would give and the one that says what is actually wrong with
              // the address.
              disabled={!state.canEdit || write.isPending}
              inputMode="url"
              onChange={(event) => {
                setDraft(event.target.value)
                setInvalid(null)
              }}
              placeholder={state.inheritedHomepage}
              spellCheck={false}
              type="text"
              value={draft}
            />
          </FormField>
          <div className="flex items-center gap-2">
            <button
              className="admin-button admin-button-primary admin-button-compact"
              disabled={!state.canEdit || write.isPending || unchanged}
              type="submit"
            >
              {write.isPending ? 'Saving…' : 'Save'}
            </button>
            {state.overriddenHere ? (
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                disabled={!state.canEdit || write.isPending}
                onClick={clear}
                type="button"
              >
                Clear
              </button>
            ) : null}
          </div>
          <FormError>{failure}</FormError>
          <FormSuccess>{notice}</FormSuccess>
        </form>
      </ScopedSettingGate>

      {state.canEdit && scope !== 'user' ? (
        <div className="mt-3">
          <ScopedSettingLock
            disabled={write.isPending}
            locked={state.lockedHere}
            onChange={(locked) => commit(state.ownValue || null, locked, 'Saved.')}
            scope={scope}
          />
        </div>
      ) : null}
    </div>
  )
}
