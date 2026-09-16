import { openExternalUrl } from '../../lib/open-external-url'
import type {
  PageHeaderAction,
  PageHeaderMenuItem,
} from './ResponsivePageHeader'
import type { ScreenBarAction, ScreenBarMenuItem } from '../../navigation/screen-bar'

// A header action, described for the native navigation bar.
//
// Everything that changes what the action *looks like* travels as data;
// everything that decides what it *does* stays in a closure (`perform`). That
// split is deliberate. Three of the four kinds do not run their `onSelect`:
//
//   - a `submit` action's `onSelect` is `() => undefined` and the work is in
//     its form's `onSubmit` — Notifications' "Save preferences", the Knowledge
//     editor's Save. Reconstructing that natively would mean shipping the rule
//     as well as the data;
//   - a toggle inverts its own `checked` through `onChange`;
//   - a link may have to leave through the shell rather than follow an href.
//
// `selected` and `checked` travel because a live call, an open search and a
// recording routine are states the bar has to show, not just fire.

const toMenuItem = (item: PageHeaderMenuItem): ScreenBarMenuItem => ({
  checked: item.checked ?? false,
  disabled: item.disabled ?? false,
  id: item.id,
  label: item.label,
})

/**
 * A `submit` action works only by submitting its form, so the bar submits it.
 * `getElementById`, never `querySelector`: these ids come from React's
 * `useId()` and contain colons, which are not valid in a CSS selector.
 */
const submitForm = (formId: string | undefined): void => {
  if (!formId) return
  const form = document.getElementById(formId)
  if (form instanceof HTMLFormElement) form.requestSubmit()
}

const performFor = (action: PageHeaderAction): ((itemId?: string) => void) => {
  // Filtered out before this is reached; answered rather than asserted so a
  // future caller gets a no-op instead of a crash.
  if (action.kind === 'custom') return () => undefined
  if (action.kind === 'menu') {
    return (itemId?: string) => {
      const item = action.items.find((candidate) => candidate.id === itemId)
      if (!item || item.disabled) return
      if ('href' in item) {
        void openExternalUrl(item.href).then((dispatch) => {
          if (dispatch === 'browser') window.open(item.href, item.target ?? '_self')
        })
        return
      }
      item.onSelect()
    }
  }
  if (action.kind === 'link') {
    return () => {
      void openExternalUrl(action.href).then((dispatch) => {
        if (dispatch === 'browser') window.open(action.href, action.target ?? '_self')
      })
    }
  }
  if (action.kind === 'toggle') {
    return () => action.onChange(!action.checked)
  }
  return () => {
    if (action.submit) {
      submitForm(action.form)
      return
    }
    action.onSelect()
  }
}

/**
 * A `custom` action is React the screen draws itself, so the native bar has no
 * lane for it and it is left out here rather than published as a button that
 * would fire nothing. It is not dropped: `ScreenHeader` renders custom actions
 * with the page under the native bar, the way `eyebrow` and `leading` already
 * stay with the page.
 */
export const toScreenBarActions = (
  actions: PageHeaderAction[] | undefined,
): ScreenBarAction[] => (actions ?? [])
  .filter((action) => action.kind !== 'custom')
  .map((action) => ({
    checked: action.kind === 'toggle' ? action.checked : null,
    disabled: action.disabled ?? false,
    icon: action.barIcon ?? null,
    id: action.id,
    items: action.kind === 'menu' ? action.items.map(toMenuItem) : null,
    kind: action.kind ?? 'button',
    label: action.label,
    perform: performFor(action),
    primary: action.primary ?? false,
    priority: action.priority,
    selected: action.selected ?? action.pressed ?? false,
    submit: action.kind !== 'menu' && action.kind !== 'toggle' && action.kind !== 'link'
      ? action.submit ?? false
      : false,
    tone: action.tone ?? null,
  }))
