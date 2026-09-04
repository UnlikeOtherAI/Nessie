# Secret management

## The vault is required to save a secret

**Nessie cannot store a secret without a configured Infisical vault.** Nessie
holds metadata; the vault holds every value. With no vault there is nowhere
safe to put one, so the write is refused rather than downgraded — there is
deliberately no PostgreSQL fallback and no plaintext path.

Two independent vault projects gate two surfaces. Configure the one you need:

| Surface | Requires | Without it |
| --- | --- | --- |
| **Save a secret** (`/settings/secrets`, `POST /api/secrets`) | `INFISICAL_API_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_SERVICE_TOKEN[_FILE]` | `503 SECRETS_NOT_CONFIGURED` on save, rotate and revoke |
| **Personal model subscriptions** (`/settings/connections`) | `NESSIE_SUBSCRIPTION_VAULT_API_URL`, `_PROJECT_ID`, `_TOKEN` | Card reads "Not available on this deployment"; linking refused |

These are **two separate Infisical projects on purpose**, never one shared
identity: the Secrets project's personal partition holds a person's ordinary
captured secrets, so an identity scoped there could read all of them. A
subscriptions token must be refused (403) against the Secrets project.
Provisioning, the isolation check, and rotation are in
[deployment/why-these-choices.md](./deployment/why-these-choices.md) → "Personal model subscriptions vault" and
"Infisical vault". In Compose, Infisical only runs with
`COMPOSE_PROFILES=secrets`.

Listing secrets keeps working without a vault — `GET /api/secrets` reads
Nessie's own metadata rows and never touches Infisical. Only writes need it.

### What does *not* go through the vault

So an operator is not misled into thinking a missing vault breaks everything:
connector and OAuth credentials are a **separate legacy store** and are
unaffected. MCP connector secrets and OAuth access/refresh tokens, Slack/Gmail
comms tokens, Browserbase keys, and APNs/FCM push secrets are AES-256-GCM
encrypted at rest in PostgreSQL under the deployment's `NESSIE_AUTH_SECRET`,
addressed by opaque `secret_*` / `credentialRef` pointers. That is the
migration concern named under "Authority split" below, not a second vault. Org
inference-provider keys and the deployment model key are environment variables
and are likewise unaffected.

## Security invariant

A language model may know that a secret exists and may be authorised to use it,
but secret material must never enter model context, prompts, tool definitions or
arguments, tool results, memory, embeddings, search, logs, traces, error
reports, notifications, summaries, or inter-agent messages.

Humans can receive `reveal` only through a future step-up-authenticated flow.
Agents can receive `use` only. An agent can never receive `reveal`.

## Authority split

Infisical is the vault and owns secret values, encryption, versions, rotation,
and vault audit. Nessie owns the user-visible metadata, scope, grants, product
policy, and its own audit trail. The first-class `Secret` and `SecretGrant`
records contain no secret value, ciphertext, encryption key, or vault token.
Existing connector/OAuth secret storage is a separate legacy migration concern;
new secret-capture flows must never add values to Nessie's PostgreSQL database.

`Secret.vaultReference` is an opaque Infisical location. It is the only
connection from a Nessie secret record to vault material. `SecretGrant` contains
the four separate capabilities:

- `use` — perform an authorised operation without disclosing a value;
- `reveal` — human-only raw-value disclosure, not implemented in the MVP;
- `manage` — change metadata, replace, rotate, revoke;
- `delegate` — issue further grants.

Every vault location is hard-partitioned as
`/nessie/<organizationId>/<scopeType>/<scopeId>`, using only stable structural
IDs. Personal paths use the owner user ID, team paths the team ID, project paths
the project ID, and team paths the organisation ID. Nessie uses the same
path for create, rotate, and revoke; `vaultReference` records that exact path
with the server-minted opaque secret name. Display names never enter a vault
path, and secret values are neither returned nor logged. The folder hierarchy
is created on demand before a first write, one path segment at a time; a
concurrent already-existing-folder conflict is successful.

The current MVP exposes metadata-only create, list, rotate, revoke, and grant
endpoints. It rejects any attempt to grant `reveal` to an agent. No endpoint
returns a secret value.

## Scope

A secret has exactly one home scope: `personal`, `team`, `project`, or
`team`. A personal secret is bound to its owner. Team, team, and
project mutation is owner-gated and confirms the requested target belongs to
the caller's organisation. Reads are entitlement-scoped: an owner sees all
metadata; other users see their own personal secrets and explicit user grants.

Phase 1 exposes Personal and Project selection in the UI. Team and Team
are preserved in the metadata model and API for an owner-managed surface.

## Capture and ingestion

The same deterministic scanner runs in the browser and API. It matches only
structural credential syntax (known provider formats, PEM blocks, JWTs,
credential-bearing connection URLs, and explicit token assignments); it does
not use an LLM or infer intent from prose.

The composer scan happens before a chat request, optimistic message, oversize
paste state, or durable draft can survive. It covers channel posts, thread and
drawer replies, new conversations, and message edits. Every doorway opens the
same protected capture form with a suggested key name and scope. Its value
control contains only the provider's structural prefix (for example
`sk_live_`) plus twelve bullet circles; opaque high-entropy values expose no
real prefix bytes. The raw value remains transient component state and is
posted only to `POST /api/secrets` through a direct request that is never
retained in the application-wide mutation cache. An explicit assignment such
as `API_KEY=…` stores only the right-hand credential bytes, not the assignment
syntax.

When one turn contains several credentials, the form advances through all of
them and saves each value separately. After the vault accepts every secret,
the composer sends a new replacement turn:
the person's original text with every detected value reduced to its safe
prefix and bullet mask, plus the approved secret name. That replacement is the
only version which reaches PostgreSQL, realtime, memory, indexing, or a model.
Discard sends no turn. This implements the requested replace semantics without
ever persisting a raw message that would later need deletion. The server scan
still repeats before message persistence and returns `SECRET_INTERCEPTED` to a
client which bypasses the composer.

Every primary, inline delegate, and spawned subtask receives the same compact
system-prompt rule: do not ask for, repeat, or place secrets in chat or
model-visible tool arguments; the secure form owns capture, and masked text is
only a protection notice. Keeping this as one shared short constant makes its
prompt-context cost fixed and prevents agent-specific copies from drifting. A
final provider-bound scan covers conversation history, memory, checkpoints,
and upstream stage text. Streaming text and reasoning hold an incomplete line
until it can be scanned, and streamed tool arguments are withheld until the
complete JSON can be sanitized. The agent loop masks initial context, compacted
context, and model output. Any tool call whose completed arguments contain a
possible credential is sanitized and refused before authorization, approval,
demonstration capture, delegation, or dispatch. Shared tool-result and durable
preview sinks redact before truncating so a boundary cut cannot reveal a
partial token. These are defence in depth; they do not make a raw secret
available to an agent.

Nessie's first-class Secrets surface writes to its configured Infisical vault.
It does **not** write GitHub Actions repository or environment secrets: that
would require a separately authorised GitHub destination and GitHub's encrypted
secret-write API, which this flow must not pretend to provide.

Structured secret mentions and a temporary-vault interception flow remain
Phase 1 follow-ups. Text pasted through the oversize-file escape hatch,
attachment filenames, raw upload bytes, and textual tool results use the
shared scanner today. The raw-byte pass catches embedded ASCII/UTF-8 credential
syntax but does not semantically extract arbitrary compressed, encrypted,
image, or proprietary binary document formats; those inputs are not yet a
complete secret-safe ingestion path.

## Deployment

`infrastructure/compose/docker-compose.prod.yml` runs Infisical and its Redis
sidecar alongside Nessie, with a separate `infisical` database and database
role on the existing `nessie-postgres` cluster. PostgreSQL and Redis have no
host ports. Caddy is the only ingress to `vault.unlikeotherai.com`.

The dedicated Infisical machine-identity access token is mounted as a Docker
secret into the API container at `/run/secrets/infisical_service_token` (the
filename is retained as a legacy deployment contract). The identity has no
organisation-level access and belongs only to the Nessie Secrets project. The
worker, executor, and agent sandboxes do not receive it. The host-only Compose
variable names and provisioning commands are documented in
[deployment.md](./deployment.md).

## Next phases

The current API is deliberately a control plane, not a credential delivery
path. Before agents use customer secrets, implement a credential broker /
Infisical Agent Proxy boundary with per-tool target-host and operation
allowlists, sanitised responses, and agent egress isolation. Non-HTTP secrets
must be used only by privileged RPC tools, never injected into an agent shell
or environment.

`USE` grants can disclose that a named secret exists, because the model needs
that metadata to select a declaratively bound tool. They never disclose its
value, vault path, token, or permission-management controls. `MANAGE` grants
authorize rotation and revocation; `DELEGATE` grants authorize access changes.

The scanner blocks structural credential formats (including quoted and
unquoted assignments, `Authorization: Bearer …`, common cloud/service keys,
database URLs, private-key blocks, and JWTs), provider prefixes, and
high-entropy token candidates on user message creation, message edits, and
chat uploads before any durable write. Its masked output is idempotent: bullet
placeholders do not reopen the capture form or trigger the API boundary. It is
deliberately a conservative first
boundary, not a replacement for the pending-secret temporary-vault flow,
content extraction from every binary document format, and interception of
integration/webhook or knowledge-base ingestion. Those are required before
enabling agents to consume those other material types.
