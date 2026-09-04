# Dashboard Designer

Dashboard Designer is Nessie's `dashboard-designer` global agent. It owns
guided dashboard work: discover a documented HTTPS API, model and probe its
declared JSON-table source, safely collect an optional token, create or edit the
dashboard, and present the finished result where the requester is already
working.

## Home and doorways

The agent's home is one per-user direct message, created through the ordinary
global-agent home route. Its owning surface is **Dashboards**: the page header
and the empty state both offer **Ask Dashboard Designer**. They open the same DM
and navigate to it rather than building a dashboard-specific chat surface.

## Connecting an API

The agent probes only a documented HTTPS source through the existing dashboard
source controls. Source validation, SSRF protections, table shape, refresh and
dashboard access remain the dashboard subsystem's policies; the agent does not
load an iframe, follow a redirect, or execute source-supplied code.

If an API requires a bearer token or named header, the agent first creates the
source, then posts a custom card with a `dashboard_source_credential` secret
destination. On the one claimed card press, the API resolves the current
member's dashboard actor and commits `setSourceCredential` in the card
transaction. Plaintext is never put in a message, card row, audit metadata,
realtime event, model context or tool result; the source keeps only its
write-only credential reference and placement. Dashboard Designer is denied the
plaintext credential tool, so this masked-card path is the only way it can
attach a source secret.

## Widget vocabulary

Dashboard Designer chooses from the same closed widget catalogue that the
editor exposes: number card (`stat`), trend (`timeseries`), breakdown (`bar`),
composition (`donut`), target progress (`gauge`), correlation (`scatter`),
table, and status. It must probe a source before choosing a widget so every
binding names a declared field of the correct type. Number cards may choose one
of the product's fixed Font Awesome Free icon identifiers; they cannot supply an
SVG, CSS class, or arbitrary icon name.

The agent still cannot pass chart-library configuration, HTML, styling, links,
or code. The shared schema validates all widget definitions before storage and
again before every renderer receives them.

## Static material and provenance

`dashboard_source_import` creates a self-contained source from JSON, CSV, a
base64-encoded XLSX workbook, extracted document text, or extracted article
text. CSV, workbook rows, and text are bounded before persistence; spreadsheet
formulas are rejected and never evaluated. Document and article text becomes a
line table so its evidence remains visible and auditable rather than being
silently summarized into invented facts.

The original supplied bytes and the resulting normalized dataset are both
immutable FileService attachments. When an agent starts with a conversation
attachment, it supplies `sourceAttachmentId`; the importer re-authorizes that
attachment against the live actor, copies its raw bytes into the dashboard's
retention, and records the source attachment reference. Extracted text is never
mislabelled as the original document. `sourceReference`, canonical URL, and
`provenance` are retained as source claims, not proof that a URL or claim was
verified. Its material row also records parser, digest, normalization loss, and
the run's consumed-source access basis. A direct API upload is private to its
submitting user by default; a source with no verified access basis cannot be
attached or presented.
A dashboard delta can only attach material compatible with its audience. A
source note is rendered in the dashboard workspace, while raw source data
continues to use the normal entitlement-checked widget read path.

## In-conversation presentation

`dashboard_present` writes a normal assistant message with a strict
`dashboardPresentation` pointer: a dashboard id and schema version, never
widget data or a credential. The message component fetches the normal dashboard
detail route for the viewer, so the pointer cannot confer access. It renders the
shared `DashboardCanvas` at a literal CSS scale in the chat card. Selecting the
preview opens the same canvas at its normal size in the URL-owned right-hand
workspace panel (`/channels/:channelId/threads/:threadId/dashboards/:dashboardId`),
never a modal. The conversation remains usable beside it. Mounted cards and the
workspace panel register with one shared dashboard subscription; chat cards load
bounded compact projections, while the workspace remains full fidelity. The
content-free `dashboard.updated` event invalidates the entitled dashboard state,
so reconnects, out-of-order events, and revoked access resolve safely.
A dashboard that is deleted or no longer entitled becomes an unavailable notice,
without exposing its prior data.

## Live edits

Every agent or HTTP mutation is a validated closed dashboard delta with a
mutation id and the revision it started from. A conditional revision claim,
child changes, delta record, and version snapshot commit in one transaction.
Retried mutation ids replay safely; a different stale write returns a visible
revision conflict and makes no partial change. Widget kinds, labels, bindings,
layout, locks, filters, executive insights, source-note visibility, and
presentation styling are all therefore updated in place on one persistent
dashboard rather than producing replacement artifacts.
