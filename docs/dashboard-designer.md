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

## In-conversation presentation

`dashboard_present` writes a normal assistant message with a strict
`dashboardPresentation` pointer: a dashboard id and schema version, never
widget data or a credential. The message component fetches the normal dashboard
detail route for the viewer, so the pointer cannot confer access. It renders the
shared `DashboardCanvas` at a literal CSS scale in the chat card. Selecting the
preview opens the same canvas at its normal size in the standard full-screen
dialog. A dashboard that is deleted or no longer entitled becomes an unavailable
notice, without exposing its prior data.
