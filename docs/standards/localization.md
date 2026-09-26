# Localization

The admin uses one `i18next` instance, initialized in
`admin/src/i18n/i18n.ts` and exposed through `LocalizationProvider`. The
For a UOA session, the account-level choice is UOA's ecosystem-wide
`global.locale` setting. Nessie reads and writes it through the server using
the verified UOA domain hash and the fresh access token produced during the
serialized refresh. That token remains transient server memory. The refresh
response carries the locale to the client; a failed write still applies the
renewed Nessie session and reports failure so the language picker can roll
back. UOA sessions never persist `User.preferences.language`; any legacy local
value is removed atomically when the signed-in account is read.

For a deployment without UOA, the account-level choice remains
`User.preferences.language`, validated by `UserPreferencesSchema` and saved
through `PATCH /api/auth/me/preferences`. `nessie.language` in local storage
is only a first-paint hint and is refreshed from the authenticated account
preference. The root document's `lang` attribute follows the active language.
Native wrappers receive the same selected code in the
existing `nessie:account` WebView message as `language: '<language-code>'`
(for example, `language: 'en-GB'`); the message continues to include the
existing avatar, display name, presence and focus fields.

Supported language codes are `en-GB` (source and default), `en-US`, `cs`,
`de`, `fr`, `it`, and `es`. The account menu lists each with a regional emoji
flag and its native language name.

## Catalog contract

Catalogs live at
`admin/src/i18n/locales/<language>/<namespace>.json`. A namespace belongs to a
feature, and its source catalog is British English in the `en-GB` directory.
Every namespace must be registered in `admin/src/i18n/namespaces.ts` and every
locale's catalog imported in `admin/src/i18n/catalogs.ts`.

Catalogs are JSON objects whose leaf keys and value types match across all
seven languages. Prefer short semantic keys, for example:

```json
{
  "title": "Projects",
  "created": "Created by {{name}}",
  "item_one": "{{count}} item",
  "item_other": "{{count}} items"
}
```

Use `useTranslation('<namespace>')` in React components. Non-component code
imports the shared `i18n` singleton and calls
`i18n.t('key', { ns: '<namespace>', name })`. Interpolation uses i18next's
`{{name}}` form; plurals use i18next's locale-aware suffixes such as `_one`,
`_other`, `_few`, and `_many`, with the `count` option. Keep interpolation
variables consistent across translations.

All user-visible application text belongs in catalogs: navigation, forms,
validation, empty/loading/error states, dialogs, notifications and accessible
labels. Dynamic user content, code, user-authored documents, provider output,
protocols, logs, and system/developer prompts are data or instructions rather
than application UI and remain untranslated. Do not translate stable machine
identifiers, API values, or user-authored content.

New namespaces should keep their files feature-owned and focused. Avoid one
global catalog per language: independent page work can then add a namespace
without creating conflicts in unrelated features. CI verifies that every
registered catalog has the same key paths for all supported languages.
