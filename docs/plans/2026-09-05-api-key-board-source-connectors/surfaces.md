# The connect flow, screen by screen

Part of [the API-key connector design](overview.md).

## 10. The connect flow, screen by screen

Owning surface: **Project → Settings → Sources**. `ConnectSourceDialog`
becomes three files under `admin/src/pages/project/settings/connect/`:
`ConnectSourceDialog.tsx` (the `Dialog` host and its step state),
`CredentialStep.tsx` (provider + method + scope + generic form + preflight),
`ContainerStep.tsx` (multi-select picker and import result). One `Dialog`, one
`TabBar` per choice, `FormField`/`FormError`/`EmptyState` from the shared kit,
no nested frames. Step state is transient (never a URL param).

### 10.1 Rule zero: home and doorways

| Capability | Owning surface | In-context doorways |
|---|---|---|
| Connect a provider by key, pick boards | `ConnectSourceDialog` from `/projects/:id/settings?section=sources` | board empty state **Connect a source**; header overflow **Connect a source…**; `/apps/:slug` **Use as a project board source** (all existing, unchanged) |
| Personal keys | `/settings/connections` → *Project tools* (`ProjectToolConnections`, existing) — rows gain method, expiry, **Replace key** | dialog step 1 "Just me"; bell alert deep link |
| Project keys | `SourcesSettingsSection` → a *Keys for this project* row list above the sources, same row component | dialog step 1 "This project"; a source row's *as Engineering Jira (project key)* text links to it |
| Organisation keys | `/settings/organization?tab=project-tools` — third tab beside Profile and Agents, `OrganizationAdministrationGate`, same row component with `scope="organization"` | dialog step 1 "Whole organisation" (owners); bell alert deep link; a source row's *as Acme Jira (organisation key)* text |
| Expiry warning | the connection's row (above) | bell (`board_source_credential_expiring`); `SourceStatusStrip` pill *key expires in 5 days* on the board |
| `credential_expired` | source row remedy **Replace key** | bell (`board_source_health`, existing); `SourceStatusStrip` |

### 10.2 Step 1 — where from, and how

The dialog opens with title **Connect a source** and the existing description.

**Accounts you can use** — a row list, one row per connection the caller may
attach (§4.3): `Jira · acme.atlassian.net · jane@acme.com` with a `Pill`
naming the scope (*Yours* / *This project* / *Organisation*), the status pill,
and for a key its expiry. Choosing a row jumps to step 2. Empty state, when
none: *You have not connected an account yet.* (existing copy) with the
provider list directly below, so the empty state is never a dead end.

**Or connect a new account** — five provider rows, glyph + name + the freshness
line from §8.2. Trello without a Power-Up is rendered, greyed, inert, with
*Needs a Trello Power-Up registered by an operator* — the scoped-settings
treatment of a control someone cannot use: visible and named, never hidden.
Choosing a provider expands the step in place:

1. **How** — a `TabBar` radiogroup only when `methods.length > 1`: **API key**
   (first, selected) · **Sign in with Linear**. Choosing sign-in triggers the
   existing popup flow and, on the callback's `postMessage`, selects the new
   connection and moves to step 2.
2. **Who can use it** — a `TabBar` radiogroup, shown for the API-key method:
   **Just me** · **This project** · **Whole organisation**; options the caller
   is not entitled to are greyed, inert and titled *Organisation owners can
   add an organisation key*. Help under it: *Shared keys are read-only. To
   move cards from Nessie into Jira, connect your own account.*
3. **The fields**, rendered from `form.fields` — `FormField` with the field's
   `label` and `help`; `secret` → password input; `url`/`email`/`date` → the
   matching input type; the whole form capped at `max-w-sm` per field, never
   the page. Above them, the `createLabel` as a link to `createUrl` (opens a
   new tab, `noopener`).

Per-provider copy, from the vendor facts:

| Provider | `createLabel` | fields and `help` |
|---|---|---|
| Asana | *Create a personal access token at app.asana.com → My apps* | **Personal access token** — *It sees exactly what you can see in Asana. An Enterprise service account token works here too and is the right choice for a shared key.* |
| Linear | *Create a personal API key at linear.app → Settings → Security* | **API key** — *Read access is enough for a shared key. Choose Write only if you are connecting as yourself and want to move issues from Nessie.* |
| GitHub | *Create a token at github.com → Settings → Developer settings* | **Personal access token** — *Which kind depends on what you will import: repositories work with either kind; organisation projects need a fine-grained token with Projects access or a classic token with `read:project`; your own projects need a classic token. We will tell you what this token can reach before you choose.* |
| Jira | *Create an API token at id.atlassian.com → API tokens* | **Site URL** (`https://your-team.atlassian.net`) — *The address you open Jira at.* · **Atlassian account email** — *The email you sign in to Atlassian with; Jira needs it beside the token.* · **API token** · **Expires on** — *Atlassian requires an expiry when you create the token. Enter the same date and we will remind you a week before it stops working.* |
| Trello | *Get a token from Trello* (the deployment-key authorize URL) | **Token** — *Trello shows the token after you approve; copy it here.* |

4. **Verify & connect** (primary; the only filled button in the dialog) posts
   `POST /api/board-sources/connections/:provider/api-key { scope,
   projectId?, values }`. The route calls `verify()`, and on success creates
   the connection and the sealed credential in one transaction, writes the
   audit entry, and returns `{ connection, preflight }`. The dialog then shows
   **Connected as Jane Doe · jane@acme.com** with each preflight note as a
   line (`ok` in the success tone, `warning` in warning) and moves to step 2.

Failure copy, by code:

| code | copy |
|---|---|
| `VALIDATION_ERROR` (site URL) | *Enter your Jira site as https://your-team.atlassian.net.* |
| `CREDENTIAL_REJECTED` (401/403 on the identity call) | *Jira did not accept that token. Check the email and token, or make a new one.* |
| `PROVIDER_UNREACHABLE` | *Jira could not be reached. Try again in a minute.* |
| `CONNECTION_DUPLICATE` | *That account is already connected as "acme.atlassian.net · jane@acme.com".* |
| `SCOPE_NOT_PERMITTED` | *Only organisation owners can add an organisation key.* |
| `PROVIDER_UNAVAILABLE` (Trello without Power-Up) | *Trello needs a Power-Up registered by an operator on this deployment.* |

The plaintext values travel once, in that request body, over the same
transport the Trello token travels today, and are never echoed. There is no
separate "test" route: verify-then-store in one call means one plaintext round
trip, not two.

### 10.3 Step 2 — what to bring in

Title line: **Bring in from Jira · acme.atlassian.net**, with *Change* linking
back. Below it a search input and a checkbox row list from
`GET /api/board-sources/connections/:id/containers` — `label` bold, `hint`
muted (*Acme · PROJ*), rows filter as the person types. A counter beside the
primary button: **Import 4 boards**. Twenty at most per import; the button
says so if exceeded.

Empty state: *This account cannot see any Jira projects. Check its
permissions at* `createUrl` *or connect a different account.* — with the
GitHub variant naming the preflight reason when there is one (*This
fine-grained token was not granted any repositories*).

Loading and errors use the existing query states; `CONNECTION_NEEDS_REAUTHORIZATION`
from the containers route becomes *Replace this key first* with the rotate
form one click away.

### 10.4 Import, and what the person sees after

**Import** posts `{ connectionId, containers: [{ container, name }] }`. The
route (`sources-import.ts`, split out of `sources.ts`):

1. Loads the connection through the scope predicate (§4.3); refuses the whole
   request for a connection the caller may not use.
2. Lists containers **once** and validates every requested one against that
   list (the existing re-list, no longer per container).
3. For each container, in order, in its own transaction: `describeContainer`,
   field reconciliation (below), `createBoardSource`, enqueue
   `board-source.sync.initial`. A throw or a `BoardSourceError` for one
   container records a `refused` entry `{ container, containerKey, error,
   message }` and continues.
4. Returns `200 { created: BoardSourceRecord[], refused: [...] }`.

Field reconciliation replaces `sources.ts` 164–181:

- same `name` and `type` → reuse; for `select`/`multi_select`, options missing
  by label are appended with fresh stable ids (a rename never rewrites a
  value; the parent design's option rule) — so the second board's "Priority"
  with an extra *Blocker* option grows the project's field rather than
  creating "Priority 2";
- same `name`, different `type` → create `"<name> (<container label>)"` and
  add a `note` to the created record: *"Priority" already exists as a select
  field; this board's text field was added as "Priority (Mobile)"*;
- `FIELD_NAME_TAKEN` on that fallback name → the field stays unmapped and the
  note says so. Nothing is dropped silently, which is what happens today (T6).

The dialog closes when everything was created, selecting the first new source
(`onCreated`). When something was refused, it stays open on a result view:
created rows with a success pill *Importing*, refused rows with the sentence
(*Jira answered 403 for PROJ — this account cannot browse it*), and a single
**Done**. Behind it, `SourcesSettingsSection` already lists the created
sources with *first sync running*.

### 10.5 The rotate form

The same `CredentialStep` form, opened as a `Dialog` titled **Replace the Jira
key** from any *Replace key* doorway, with `url`/`email`/`text` fields
prefilled from `credentialParams` and the label (the email is not stored in
plaintext, so it is *not* prefilled; the help says *the same address as
before, or a new one*), `secret` fields empty, `date` empty. Submit is
`PUT /api/board-sources/connections/:id/api-key { values }`.

