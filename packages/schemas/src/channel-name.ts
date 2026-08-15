// The one canonical channel-naming rule, shared by the API (which persists it)
// and the admin (which shows the person what they are about to get). It used to
// live as three byte-identical private copies — two in `admin/src`, one in
// `api/src/services/channel-slugs.ts` carrying a comment describing itself as a
// "mirror of the admin rules". A rule that must agree across a network boundary
// is a contract, so it belongs here.
//
// Channel names are lowercase, hyphen-separated, and free of anything that is
// not a letter, a digit or a hyphen. `label` and `slug` are therefore the same
// string: there is no display form distinct from the addressable form.

/** Canonical form. Apply on save — never on every keystroke (see below). */
export const toChannelSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

// Typing-safe form, for an input a person is mid-word in. It applies every rule
// that can be applied to a prefix — case, illegal characters, spaces — but
// leaves trailing and repeated hyphens alone, because collapsing them per
// keystroke makes a hyphen impossible to type: `toChannelSlug('design-')` is
// `'design'`, so the character is erased the instant it is entered. The value is
// run through `toChannelSlug` on submit, which is where the collapsing belongs.
export const toChannelNameInput = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/^-+/, '')
