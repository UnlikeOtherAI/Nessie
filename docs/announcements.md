# Instance announcements and News

The platform super-admin manages both publication types at **Admin → Advanced →
Announcements** (`/admin/advanced/announcements`). The page has **Strip** and
**News** tabs. This is instance-wide content: it is shown to every signed-in
account regardless of its organisation or selected team. The API checks the
existing, out-of-band `User.superAdmin` platform entitlement on every write;
organisation owner/admin roles do not grant access. These records contain no
UOA-owned profile or membership data.

## Strip

The operator writes a short plain-text message, optionally gives it an internal
path (for example `/projects`) or an HTTP(S) link, and switches it on. The
entire text area is the link. The strip is at the top of the authenticated app,
before the page or the mobile menu. Its X stores the current revision in that
device's local storage. Closing it on one device does not close it elsewhere;
editing and saving creates a new revision that can be shown again. A dismissed
revision has no retrieval surface for the reader.

## News

The operator writes a header with text, an image, or a YouTube link, optionally
combining them. Images can use a public URL or an uploaded PNG, JPEG, WebP or
GIF (up to 5 MB). A header-only draft can be saved, while a published article
needs at least one content item. Uploaded images are stored once per article and
served only to signed-in readers after publication. News is a chronological
article list. If an article has a YouTube link, its image (or YouTube thumbnail)
is a preview button. The YouTube player is loaded only when the reader taps it.
The editor keeps the selected article in the page URL so returning from News
restores the article being edited.

**News** is in the account menu. On a single-column mobile layout it opens a
full page with the navigation framework's Back to the actual origin. On wider
layouts it opens the shared Dialog over the current page, so closing it leaves
that page in place. The Dialog suspends native iPad list-column chrome while it
is open; the channel creation control cannot float above News. The same reader
component renders in both presentations.

Each account has one `platform_news_read_states` row across all organisations
and devices. `last_seen_publication_version` records the latest publication
visible when News is opened. The account-menu counter counts published articles newer than that
marker and clears after opening News. A new publication increments it. Editing
an existing published article does not create a new publication; unpublishing
removes it from the feed; republishing gives it a new publication number. There is no per-organisation alert fan-out or copied
news message. The account-keyed query never reuses a previous account's
notification state during a sign-in switch. The `notifications_muted` toggle on the News reader suppresses
the small in-app toast and avatar dot, while retaining the menu counter. The
toast opens News when tapped. The reader's polling query checks for new publications every 30 seconds and also
refreshes on focus.

## Routes and storage

- `GET /api/announcements/banner`: active strip for a signed-in human.
- `GET /api/news`, `POST /api/news/read` with `throughVersion` from the visible
  feed, and `PATCH /api/news/preferences`: published News, account read marker,
  and notification preference. A publication arriving between the feed request
  and read acknowledgement stays unread.
- `GET /api/news/{id}/image`: an authenticated published article's uploaded
  image. Draft images are not readable from this route.
- `GET /api/platform/announcements`, `PUT /api/platform/announcements/banner`,
  the create/update/delete `/api/platform/announcements/news` routes, and
  `POST /api/platform/announcements/news/{id}/image`: super-admin-only editing.
- `platform_banners` has one `current` row. `platform_news_articles` contains
  drafts and published articles. `platform_news_images` holds the optional
  uploaded image bytes, cascading with its article. `platform_news_read_states` is keyed by the
  stable local user id (which is bound to UOA subject on an SSO install).

Publication and read state are database-backed so they survive restarts and
sync between a person's devices. Strip dismissal is deliberately local storage
only. News content is plain text, and server validation limits URLs to internal
paths, HTTP(S) images, and YouTube video identifiers; the reader never renders
operator text as HTML.

The headless `pnpm --filter @nessie/admin test:e2e:announcements` suite drives
two accounts on an isolated install, uploads a preview image, checks the desktop
dialog and phone page, and verifies that an iPad shell retires the channel
creation column while News is open.
